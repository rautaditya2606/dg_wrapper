import dotenv from 'dotenv';
import dns from 'dns';
import http from 'http';
import https from 'https';
import { fileURLToPath } from 'url';
import path from 'path';
import express from 'express';
import { GoogleSearch } from 'google-search-results-nodejs';
import Anthropic from '@anthropic-ai/sdk';
import rateLimit from 'express-rate-limit';
import pino from 'pino';
import HttpsProxyAgent from 'https-proxy-agent';
import { WebSocketServer } from 'ws';
import { chat, formatAIResponse, setBroadcastFunction } from './src/assistant.js';
import { SearchClient } from './src/search.js';

// Initialize dotenv
dotenv.config();

// Configure DNS and threadpool
dns.setDefaultResultOrder('ipv4first');  // Prioritize IPv4
process.env.UV_THREADPOOL_SIZE = 16;  // Increase thread pool for better network handling

// Force IPv4 globally
dns.setDefaultResultOrder('ipv4first');
const forceIPv4 = (protocol) => {
  const agent = new protocol.Agent({
    family: 4,
    keepAlive: true,
    keepAliveMsecs: 1000,
    maxSockets: Infinity,
    maxFreeSockets: 256,
    timeout: 30000
  });
  return agent;
};

http.globalAgent = forceIPv4(http);
https.globalAgent = forceIPv4(https);

// Add environment variable to force IPv4
process.env.NODE_OPTIONS = '--dns-result-order=ipv4first';

// Create logger instance
const logger = pino();
const log = logger;  // Create an alias for consistency

// Add API key validation logging
console.log('API Key format check:', process.env.ANTHROPIC_API_KEY?.startsWith('sk-ant-'));
console.log('API Key length:', process.env.ANTHROPIC_API_KEY?.length);
console.log('RapidAPI Key available:', !!process.env.RAPIDAPI_KEY);
console.log('Pexels API Key available:', !!process.env.PEXELS_API_KEY);

const app = express();
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY?.trim(),
});
const search = new GoogleSearch(process.env.SERPAPI_API_KEY);
search.options = {
  family: 4,
  lookup: ['v4'],
  ipv6: false,
  hints: dns.ADDRCONFIG | dns.V4MAPPED,
  all: false,
  agent: forceIPv4(https),  // Use our IPv4 agent
  timeout: 30000,  // 30 second timeout
  resolveWithFullResponse: true,
  forever: true,  // Keep-alive
};

// Configure proxy if HTTPS_PROXY is set
if (process.env.HTTPS_PROXY) {
  const proxyAgent = new HttpsProxyAgent(process.env.HTTPS_PROXY);
  search.options = {
    ...search.options,
    agent: proxyAgent
  };
}

// Set up __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "public")));
app.set("view engine", "ejs");
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Add rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});

app.use(limiter);

app.get("/", (req, res) => {
  res.render("index", { result: null, query: null });
});

app.get("/terminal-demo", (req, res) => {
  res.render("terminal-demo");
});

// Add retry utility function
const withRetry = async (fn, retries = 5, backoff = (count) => Math.min(1000 * Math.pow(2, count), 10000)) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      const isNetworkError = [
        'ETIMEDOUT',
        'ENETUNREACH',
        'ECONNREFUSED',
        'ECONNRESET',
        'ENOTFOUND',
        'EAI_AGAIN'
      ].includes(error.code) || (error.errors || []).some(e => e?.code === 'ETIMEDOUT' || e?.code === 'ENETUNREACH');

      if (i === retries - 1 || !isNetworkError) {
        throw error;
      }

      const delay = backoff(i);
      pino.warn({
        attempt: i + 1,
        delay,
        error: error.message
      }, `Retrying after network error`);

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};

// Initialize the search client
const searchClient = new SearchClient(process.env.SERPER_API_KEY, process.env.RAPIDAPI_KEY, process.env.PEXELS_API_KEY);

// Fix timeout issue in handleSerpApiRequest
// Update handleSerpApiRequest to use SerpSearchClient methods
const handleSerpApiRequest = async (type, params) => {
  try {
    if (!params.q || typeof params.q !== 'string') {
      throw new Error('Invalid query parameter: "q" must be a non-empty string');
    }

    logger.info({ type, query: params.q }, 'Starting search request');

    const options = {
      timeout: 30000,
      retries: 3,
      backoff: (retryCount) => Math.min(3000 * Math.pow(2, retryCount), 30000)
    };

    return await withRetry(
      async () => {
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error(`Request timed out after ${options.timeout}ms`)), options.timeout)
        );

        const searchPromise = type === 'images'
          ? searchClient.searchImages(params)
          : searchClient.searchLocal(params);

        return await Promise.race([timeoutPromise, searchPromise]);
      },
      options.retries
    );
  } catch (error) {
    logger.error({
      error: error.message,
      stack: error.stack,
      type: 'handleSerpApiRequest_error',
      query: params.q
    }, 'Error in handleSerpApiRequest');
    throw error;
  }
};

const SUPPORTED_MODELS = ["claude-sonnet-4-20250514"];

function validateModel(model) {
  if (!SUPPORTED_MODELS.includes(model)) {
    throw new Error(`Invalid model. Supported models are: ${SUPPORTED_MODELS.join(', ')}`);
  }
  return model;
}

// Add input validation
function validateInput(query) {
  if (typeof query !== 'string') throw new Error('Query must be a string');
  if (query.length > 300) throw new Error('Query too long (max 300 chars)');
  if (query.trim().length === 0) throw new Error('Query cannot be empty');
  return query.trim();
}

function analyzeQueryComplexity(query) {
  const complexityIndicators = {
    // High complexity triggers
    academic: /\b(research|study|analysis|theory|methodology|hypothesis|dissertation|peer.?review)\b/i,
    technical: /\b(algorithm|implementation|architecture|framework|optimization|performance)\b/i,
    analytical: /\b(compare|contrast|evaluate|assess|analyze|critique|examine)\b/i,
    controversial: /\b(debate|controversy|pros.?cons|advantages.?disadvantages|benefits.?risks)\b/i,
    multifaceted: /\b(factors|aspects|dimensions|perspectives|implications|considerations)\b/i,
    
    // Medium complexity
    explanatory: /\b(how|why|what|explain|understand|clarify)\b/i,
    current: /\b(latest|recent|current|today|now|2024|2025)\b/i,
    
    // Simple queries
    factual: /\b(when|where|who|define|definition)\b/i,
    basic: /\b(price|cost|location|address|phone|hours)\b/i
  };

  let score = 0;
  let triggers = [];

  // High complexity (+3 each)
  Object.entries(complexityIndicators).slice(0, 5).forEach(([key, regex]) => {
    if (regex.test(query)) {
      score += 3;
      triggers.push(key);
    }
  });

  // Medium complexity (+2 each)
  Object.entries(complexityIndicators).slice(5, 7).forEach(([key, regex]) => {
    if (regex.test(query)) {
      score += 2;
      triggers.push(key);
    }
  });

  // Simple queries (-1 each)
  Object.entries(complexityIndicators).slice(7).forEach(([key, regex]) => {
    if (regex.test(query)) {
      score -= 1;
      triggers.push(key);
    }
  });

  // Additional complexity factors
  const wordCount = query.split(/\s+/).length;
  if (wordCount > 10) score += 1;
  if (wordCount > 20) score += 2;
  
  // Question marks often indicate complexity
  const questionMarks = (query.match(/\?/g) || []).length;
  if (questionMarks > 1) score += 1;

  return {
    score: Math.max(0, score),
    level: score <= 1 ? 'simple' : score <= 4 ? 'medium' : 'deep',
    triggers
  };
}

function generateSystemPrompt(query, complexity) {
  const basePrompt = `Analyze these search results for "${query}"`;
  
  const prompts = {
    simple: `${basePrompt} and provide a concise analysis in this JSON format:

{
    "summary": "1-2 sentence direct answer",
    "keyPoints": ["key fact 1", "key fact 2"],
    "analysis": {
        "relevance": "how well results match query",
        "credibility": "basic source assessment"
    }
}`,

    medium: `${basePrompt} and provide a structured analysis in this JSON format:

{
    "summary": "2-3 sentence overview with context",
    "keyPoints": ["point 1", "point 2", "point 3"],
    "analysis": {
        "contentQuality": "assessment of information quality",
        "credibility": "evaluation of source reliability",
        "relevance": "relevance and completeness",
        "insights": "notable findings or patterns"
    },
    "context": {
        "background": "relevant background information",
        "relatedTopics": ["related topic 1", "related topic 2"]
    }
}`,

    deep: `${basePrompt} and provide an in-depth analytical response in this JSON format:

{
    "summary": "Short executive summary with key insight",
    "keyPoints": ["Insight 1", "Insight 2", "Insight 3", "Insight 4"],
    "analysis": {
        "depth": "depth of information",
        "accuracy": "accuracy and consistency of facts",
        "bias": "any noticeable bias in sources",
        "coverage": "how comprehensive the result set is",
        "comparisons": "differences among results"
    },
    "context": {
        "background": "brief background for better understanding",
        "relatedConcepts": ["concept 1", "concept 2"],
        "openQuestions": ["unanswered question 1", "further exploration 2"]
    }
}`
  };

  return prompts[complexity.level];
}

// Initialize serpApi properly
const serpApi = search; // Use the GoogleSearch instance initialized earlier

// Replace the existing /search route with this updated version
app.post("/search", async (req, res) => {
  const query = req.body.query;
  
  try {
    // Validate input
    const validatedQuery = validateInput(query);
    
    // Analyze query complexity
    const complexity = analyzeQueryComplexity(validatedQuery);
    logger.info({ query: validatedQuery, complexity }, 'Query complexity analysis');
    
    // Perform search with timeout
    const [searchResults, textResults] = await performSearch(validatedQuery);
    
    // Generate dynamic system prompt
    const systemPrompt = generateSystemPrompt(validatedQuery, complexity);
    
    // Get Anthropic analysis with dynamic prompt
    const anthropicResponse = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: complexity.level === 'deep' ? 1500 : complexity.level === 'medium' ? 1000 : 600,
      temperature: 0.7,
      messages: [{
        role: "user",
        content: `${systemPrompt}

Search Results to Analyze:
${JSON.stringify(textResults.organic_results?.slice(0, 3), null, 2)}

Ensure the response is valid JSON that exactly matches the specified structure.`
      }]
    });

    try {
      const analysisData = await parseAnthropicResponse(anthropicResponse);
      const templateData = createTemplateData(validatedQuery, analysisData, textResults, searchResults, complexity);
    } catch (error) {
      logger.error({
        error: error.message,
        stack: error.stack,
        type: 'anthropic_error',
        query: validatedQuery
      }, 'Error in anthropic.messages.create');
      throw error;
    }

    // Create template data based on complexity level
    const templateData = createTemplateData(validatedQuery, analysisData, textResults, searchResults, complexity);

    try {
      res.render("index", templateData);
    } catch (renderError) {
      logger.error({ 
        error: renderError.message,
        complexity: complexity.level,
        triggers: complexity.triggers
      }, "Template render failed");
      
      res.status(500).render("index", {
        query: validatedQuery,
        result: {
          error: `Failed to display results: ${renderError.message}`,
          searchResults: textResults.organic_results?.slice(0, 3) || [],
          images: searchResults.image_results?.slice(0, 3) || [],
        }
      });
    }
    
  } catch (error) {
    logger.error({ 
      error: error.message,
      stack: error.stack,
      query 
    }, "Search failed");
    
    res.render("index", {
      query,
      result: {
        error: `Error: ${error.message}. Please try again later.`,
        searchResults: [],
        images: [],
      },
    });
  }
});

// Helper function to check if query needs web search using Claude
async function shouldDoWebSearch(query) {
  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 50,
    temperature: 0,
    messages: [{
      role: "user",
      content: `Analyze this query: "${query}"

Determine if this is a conversational message (like greetings, small talk, or casual chat) or if it's an information-seeking query that would benefit from web search results.

Reply with only one word - either "conversational" or "search".
Do not include any other text or explanation in your response.`
    }]});

    const decision = message.content[0].text.trim().toLowerCase();
    return decision === 'search';
}

// Helper function to determine if query needs deep analysis
async function shouldDoDeepAnalysis(query) {
  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 50,
    temperature: 0,
    messages: [{
      role: "user",
      content: `Analyze this query: "${query}"

Determine if this query would benefit from deep analysis with structured tasks, recommendations, and context. Consider these factors:
- Complex problem-solving or planning queries
- Queries requiring multiple steps or actions
- Research or learning queries with practical applications
- Queries about trends, comparisons, or strategic decisions
- Queries that could benefit from actionable insights

Reply with only one word - either "analyze" or "simple".
Do not include any other text or explanation in your response.`
    }]});

    const decision = message.content[0].text.trim().toLowerCase();
    return decision === 'analyze';
}

// New POST /analyze route
app.post("/analyze", async (req, res) => {
  const query = req.body.query;

  try {
    if (!query) {
      throw new Error("Query is required");
    }

    let doWebSearch = true;
    try {
      doWebSearch = await shouldDoWebSearch(query);
    } catch (error) {
      logger.error('Claude API call failed for web search decision', {
        error: error.message,
        stack: error.stack
      });
      // If Claude fails, default to web search for safety
      doWebSearch = true;
    }

    if (!doWebSearch) {
      try {
        const message = await anthropic.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1024,
          temperature: 0.7,
          messages: [
            { role: "user", content: query }
          ]
        });

        return res.json({
          query,
          structuredAnswer: [{ type: "text", text: message.content[0]?.text || "No response" }],
          isConversational: true,
          hasWebResults: false
        });
      } catch (apiError) {
        logger.error({
          error: apiError.message,
          stack: apiError.stack,
          type: 'anthropic_api_error',
          query
        }, 'Error in Claude API call');
        throw apiError;
      }
    }

    let serpResults = { organic_results: [], image_results: [] };

    try {
      const baseParams = {
        q: query,
        engine: "google",
        safe: "active",
        num: 10,
        google_domain: "google.co.in",
        gl: "in",
        hl: "en"
      };

      const [imageResults, webResults] = await Promise.all([
        handleSerpApiRequest('images', { ...baseParams, tbm: "isch" }),
        handleSerpApiRequest('web', { ...baseParams })
      ]);

      serpResults = {
        organic_results: Array.isArray(webResults.result) ? webResults.result.slice(0, 10).map(r => ({
          title: r.title,
          link: r.href,
          snippet: r.body
        })) : [],
        image_results: imageResults.image_results?.slice(0, 12) || []
      };
    } catch (searchError) {
      logger.error({
        error: searchError.message,
        stack: searchError.stack,
        type: 'search_error',
        query
      }, 'Web search failed');
      throw searchError;
    }

    const prompt = `
You are a helpful expert providing information about ${query}. Create a well-structured guide without repeating the query.

Structure your response using these sections:

## Key Resources
- List the most relevant and high-quality resources
- Group them by category (Free, Paid, Interactive, etc.)
- Include specific recommendations with brief descriptions

## Learning Paths
- Suggest different approaches for learning
- Outline progression paths from beginner to advanced
- Recommend specific steps and milestones

## Pro Tips
- Share important tips and best practices
- Point out common pitfalls to avoid
- Include expert insights

## Next Steps
- Provide actionable next steps
- Consider different skill levels
- Suggest ways to practice and apply knowledge

Keep each section concise and practical. Focus on providing value without repeating context.
`.trim();

    try {
      const message = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        temperature: 0.7,
        messages: [{ role: "user", content: prompt }]
      });

      const formattedResponse = formatAIResponse(message.content[0]?.text || "No response");

      res.json({
        query,
        structuredAnswer: [{ type: "text", text: formattedResponse }],
        serpResults,
        isConversational: false,
        hasWebResults: serpResults.organic_results.length > 0 || serpResults.image_results.length > 0
      });
    } catch (finalError) {
      logger.error({
        error: finalError.message,
        stack: finalError.stack,
        type: 'final_prompt_error',
        query
      }, 'Error in final prompt processing');
      throw finalError;
    }

  } catch (error) {
    logger.error('Error in /analyze:', {
      error: error.message,
      stack: error.stack,
      query
    });
    res.status(500).json({ 
      error: error.message,
      isConversational: false
    });
  }
});

// Chat endpoint
app.post('/chat', async (req, res) => {
    try {
        const query = req.body.query;
        if (!query) {
            return res.status(400).json({ error: 'Query is required' });
        }

        // Array to collect web activity
        const webActivity = [];

        // Create an event listener for web activities
        const webActivityHandler = (activity) => {
            webActivity.push(activity);
            // Log each activity for debugging
            logger.info({ activity }, 'Web activity received');
        };

        // Add the event listener before processing
        process.on('webActivity', webActivityHandler);

        // Process the chat query
        const { response, webActivity: activities } = await chat(query);

        // Remove the event listener
        process.removeListener('webActivity', webActivityHandler);

        // Send response with web activity
        res.json({
            response: response,
            webActivity: [...webActivity, ...activities]
        });

    } catch (error) {
        logger.error('Chat error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Route to render the test page
app.get("/test", (req, res) => {
  res.render("test", { 
    results: [],
    webResults: [],
    imageResults: [],
    error: null,
    query: null
  });
});

// Download slides route
app.post("/download-slides", async (req, res) => {
  try {
    const { query, analysis, searchResults, images, timestamp } = req.body;
    
    if (!query || !analysis) {
      return res.status(400).json({ error: 'Missing required data for slides' });
    }

    // Generate beautiful HTML slides
    const slidesHtml = generateSlidesHtml(query, analysis, searchResults, images, timestamp);
    
    // Set headers for download
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `attachment; filename="slides_${query.replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().split('T')[0]}.html"`);
    
    res.send(slidesHtml);
  } catch (error) {
    logger.error('Error generating slides:', error);
    res.status(500).json({ error: 'Failed to generate slides' });
  }
});

// Helper function to generate slides HTML
function generateSlidesHtml(query, analysis, searchResults, images, timestamp) {
  const slides = [];
  
  // Slide 1: Title
  slides.push(`
    <div class="slide title-slide">
      <div class="slide-content">
        <h1 class="slide-title">${query}</h1>
        <div class="slide-subtitle">Comprehensive Analysis & Insights</div>
        <div class="slide-meta">
          <span class="date">${new Date(timestamp).toLocaleDateString()}</span>
          <span class="time">${new Date(timestamp).toLocaleTimeString()}</span>
        </div>
      </div>
    </div>
  `);

  // Slide 2: Executive Summary
  if (analysis.summary) {
    // Split the summary into two parts
    const summaryText = analysis.summary;
    const words = summaryText.split(' ');
    const midPoint = Math.ceil(words.length / 2);
    const leftPart = words.slice(0, midPoint).join(' ');
    const rightPart = words.slice(midPoint).join(' ');
    
    slides.push(`
      <div class="slide summary-slide">
        <div class="slide-content">
          <h2 class="slide-title">Executive Summary</h2>
          <div class="summary-content">
            <div class="summary-columns">
              <div class="summary-column left-column">
                <h3>Overview</h3>
                <div class="summary-text">${leftPart}</div>
              </div>
              <div class="summary-column right-column">
                <h3>Key Insights</h3>
                <div class="summary-text">${rightPart}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `);
  }

  // Slide 3: Key Points
  if (analysis.keyPoints && analysis.keyPoints.length > 0) {
    slides.push(`
      <div class="slide keypoints-slide">
        <div class="slide-content">
          <h2 class="slide-title">Key Points</h2>
          <ul class="keypoints-list">
            ${analysis.keyPoints.map(point => `<li>${point}</li>`).join('')}
          </ul>
        </div>
      </div>
    `);
  }

  // Slide 4: Detailed Analysis
  if (analysis.analysis) {
    slides.push(`
      <div class="slide analysis-slide">
        <div class="slide-content">
          <h2 class="slide-title">Detailed Analysis</h2>
          <div class="analysis-container">
            <div class="analysis-main-grid">
              ${analysis.analysis.contentQuality ? `<div class="analysis-item main-item"><strong>Content Quality:</strong> ${analysis.analysis.contentQuality}</div>` : ''}
              ${analysis.analysis.credibility ? `<div class="analysis-item main-item"><strong>Source Credibility:</strong> ${analysis.analysis.credibility}</div>` : ''}
              ${analysis.analysis.relevance ? `<div class="analysis-item main-item"><strong>Relevance:</strong> ${analysis.analysis.relevance}</div>` : ''}
              ${analysis.analysis.insights ? `<div class="analysis-item main-item"><strong>Key Insights:</strong> ${analysis.analysis.insights}</div>` : ''}
            </div>
            
            <div class="analysis-details">
              <div class="analysis-detail-section">
                <h3>Methodology</h3>
                <div class="detail-content">
                  <p><strong>Search Strategy:</strong> Comprehensive web search across multiple sources and databases</p>
                  <p><strong>Source Evaluation:</strong> Cross-referenced information from reputable sources</p>
                  <p><strong>Data Analysis:</strong> Synthesized findings from ${searchResults ? searchResults.length : 'multiple'} search results</p>
                </div>
              </div>
              
              <div class="analysis-detail-section">
                <h3>Context & Background</h3>
                <div class="detail-content">
                  <p><strong>Current Trends:</strong> Analysis reflects the latest developments and market conditions</p>
                  <p><strong>Historical Context:</strong> Considered relevant historical data and trends</p>
                  <p><strong>Future Implications:</strong> Evaluated potential impact and future developments</p>
                </div>
              </div>
              
              <div class="analysis-detail-section">
                <h3>Limitations & Considerations</h3>
                <div class="detail-content">
                  <p><strong>Data Freshness:</strong> Information accuracy as of the search date</p>
                  <p><strong>Source Diversity:</strong> Analysis based on publicly available information</p>
                  <p><strong>Scope:</strong> Focused on the specific query parameters provided</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `);
  }

  // Slide 5: Web Search Results
  if (searchResults && searchResults.length > 0) {
    slides.push(`
      <div class="slide results-slide">
        <div class="slide-content">
          <h2 class="slide-title">Web Search Results</h2>
          <div class="results-grid">
            ${searchResults.slice(0, 6).map((result, index) => {
              const url = result.displayed_link || result.link || result.href || '#';
              const isValidUrl = url && url !== '#' && url.startsWith('http');
              const escapedUrl = isValidUrl ? url.replace(/"/g, '&quot;').replace(/'/g, '&#39;') : '#';
              return `
                <div class="result-item ${isValidUrl ? 'clickable' : ''}" ${isValidUrl ? `onclick="openResult('${escapedUrl}')"` : ''}>
                  <div class="result-number">${index + 1}</div>
                  <div class="result-content">
                    <h3 class="result-title">${result.title}</h3>
                    <p class="result-snippet">${result.snippet || result.body || 'No description available'}</p>
                    <div class="result-url">${url}</div>
                  </div>
                  ${isValidUrl ? '<div class="click-indicator">↗</div>' : ''}
                </div>
              `;
            }).join('')}
          </div>
        </div>
      </div>
    `);
  }

  // Slide 6: Images
  if (images && images.length > 0) {
    slides.push(`
      <div class="slide images-slide">
        <div class="slide-content">
          <h2 class="slide-title">Visual Content</h2>
          <div class="images-grid">
            ${images.slice(0, 8).map(image => `
              <div class="image-item">
                <img src="${image.thumbnail}" alt="${image.title}" loading="lazy">
                <div class="image-caption">${image.title}</div>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `);
  }

  // Slide 7: Recommendations
  if (analysis.recommendations) {
    slides.push(`
      <div class="slide recommendations-slide">
        <div class="slide-content">
          <h2 class="slide-title">Recommendations</h2>
          <div class="recommendations-content">
            ${analysis.recommendations.research && analysis.recommendations.research.length > 0 ? `
              <div class="recommendation-section">
                <h3>Further Research</h3>
                <ul>
                  ${analysis.recommendations.research.map(area => `<li>${area}</li>`).join('')}
                </ul>
              </div>
            ` : ''}
            ${analysis.recommendations.applications && analysis.recommendations.applications.length > 0 ? `
              <div class="recommendation-section">
                <h3>Practical Applications</h3>
                <ul>
                  ${analysis.recommendations.applications.map(app => `<li>${app}</li>`).join('')}
                </ul>
              </div>
            ` : ''}
          </div>
        </div>
      </div>
    `);
  }

  // Generate the complete HTML document
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Slides - ${query}</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%);
            color: #e0e0e0;
            overflow: hidden;
            margin: 0;
            padding: 0;
        }

        .presentation-container {
            width: 100vw;
            height: 100vh;
            position: relative;
        }

        .slide {
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 4rem;
            position: absolute;
            top: 0;
            left: 0;
            opacity: 0;
            transition: opacity 0.5s ease;
            overflow-y: auto;
        }

        /* Custom scrollbar styles for slides */
        .slide::-webkit-scrollbar {
            width: 8px;
        }

        .slide::-webkit-scrollbar-track {
            background: rgba(255, 255, 255, 0.1);
            border-radius: 4px;
        }

        .slide::-webkit-scrollbar-thumb {
            background: rgba(33, 150, 243, 0.6);
            border-radius: 4px;
        }

        .slide::-webkit-scrollbar-thumb:hover {
            background: rgba(33, 150, 243, 0.8);
        }

        /* Firefox scrollbar styles for slides */
        .slide {
            scrollbar-width: thin;
            scrollbar-color: rgba(33, 150, 243, 0.6) rgba(255, 255, 255, 0.1);
        }

        .slide.active {
            opacity: 1;
        }

        .slide-content {
            max-width: 1200px;
            width: 100%;
            text-align: center;
        }

        .slide-title {
            font-size: 3rem;
            font-weight: 700;
            margin-bottom: 2rem;
            background: linear-gradient(135deg, #2196f3, #1976d2);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }

        .slide-subtitle {
            font-size: 1.5rem;
            color: #a0a0a0;
            margin-bottom: 2rem;
        }

        .slide-meta {
            display: flex;
            justify-content: center;
            gap: 2rem;
            font-size: 1rem;
            color: #a0a0a0;
        }

        .summary-text {
            font-size: 1.3rem;
            line-height: 1.7;
            max-width: 900px;
            margin: 0 auto;
            text-align: left;
            background: rgba(255, 255, 255, 0.03);
            padding: 2rem;
            border-radius: 12px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            max-height: 60vh;
            overflow-y: auto;
            word-wrap: break-word;
            overflow-wrap: break-word;
        }

        /* Custom scrollbar styles for summary text */
        .summary-text::-webkit-scrollbar {
            width: 8px;
        }

        .summary-text::-webkit-scrollbar-track {
            background: rgba(255, 255, 255, 0.1);
            border-radius: 4px;
        }

        .summary-text::-webkit-scrollbar-thumb {
            background: rgba(33, 150, 243, 0.6);
            border-radius: 4px;
        }

        .summary-text::-webkit-scrollbar-thumb:hover {
            background: rgba(33, 150, 243, 0.8);
        }

        /* Firefox scrollbar styles */
        .summary-text {
            scrollbar-width: thin;
            scrollbar-color: rgba(33, 150, 243, 0.6) rgba(255, 255, 255, 0.1);
        }

        /* Two-column layout for executive summary */
        .summary-columns {
            display: flex;
            gap: 2rem;
            max-width: 1200px;
            margin: 0 auto;
            height: 60vh;
        }

        .summary-column {
            flex: 1;
            display: flex;
            flex-direction: column;
            background: rgba(255, 255, 255, 0.03);
            border-radius: 12px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            padding: 1.5rem;
        }

        .summary-column h3 {
            color: #2196f3;
            font-size: 1.4rem;
            margin-bottom: 1rem;
            text-align: center;
            font-weight: 600;
        }

        .summary-column .summary-text {
            flex: 1;
            font-size: 1.1rem;
            line-height: 1.6;
            text-align: left;
            background: transparent;
            padding: 0;
            border: none;
            max-height: none;
            overflow-y: auto;
        }

        /* Responsive design for mobile */
        @media (max-width: 768px) {
            .summary-columns {
                flex-direction: column;
                gap: 1rem;
                height: auto;
            }
            
            .summary-column {
                padding: 1rem;
            }
            
            .summary-column h3 {
                font-size: 1.2rem;
            }
            
            .summary-column .summary-text {
                font-size: 1rem;
            }
        }

        .keypoints-list {
            list-style: none;
            text-align: left;
            max-width: 800px;
            margin: 0 auto;
        }

        .keypoints-list li {
            font-size: 1.3rem;
            margin-bottom: 1rem;
            padding-left: 2rem;
            position: relative;
        }

        .keypoints-list li::before {
            content: '•';
            color: #2196f3;
            font-size: 2rem;
            position: absolute;
            left: 0;
            top: -0.2rem;
        }

        .analysis-container {
            max-width: 1200px;
            margin: 0 auto;
        }

        .analysis-main-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 1.5rem;
            margin-bottom: 2rem;
        }

        .analysis-item.main-item {
            background: rgba(255, 255, 255, 0.05);
            padding: 1.5rem;
            border-radius: 12px;
            border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .analysis-item.main-item strong {
            color: #2196f3;
            display: block;
            margin-bottom: 0.5rem;
        }

        .analysis-details {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
            gap: 1.5rem;
        }

        .analysis-detail-section {
            background: rgba(255, 255, 255, 0.03);
            padding: 1.5rem;
            border-radius: 12px;
            border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .analysis-detail-section h3 {
            color: #2196f3;
            font-size: 1.2rem;
            margin-bottom: 1rem;
            font-weight: 600;
        }

        .detail-content p {
            margin-bottom: 0.8rem;
            line-height: 1.5;
            font-size: 0.95rem;
        }

        .detail-content strong {
            color: #10b981;
        }

        .results-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
            gap: 1.5rem;
            max-width: 1200px;
            margin: 0 auto;
        }

        .result-item {
            background: rgba(255, 255, 255, 0.05);
            padding: 1.5rem;
            border-radius: 12px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            display: flex;
            gap: 1rem;
            transition: all 0.3s ease;
        }

        .result-item.clickable {
            cursor: pointer;
            border-color: rgba(33, 150, 243, 0.3);
        }

        .result-item.clickable {
            cursor: pointer;
            border-color: rgba(33, 150, 243, 0.3);
            transition: all 0.3s ease;
        }

        .result-item.clickable {
            cursor: pointer;
            border-color: rgba(33, 150, 243, 0.3);
            transition: all 0.3s ease;
            position: relative;
        }

        .result-item.clickable:hover {
            background: rgba(255, 255, 255, 0.08);
            border-color: #2196f3;
            transform: translateY(-2px);
            box-shadow: 0 4px 15px rgba(33, 150, 243, 0.2);
        }

        .result-item.clickable:active {
            transform: translateY(0);
            box-shadow: 0 2px 8px rgba(33, 150, 243, 0.2);
        }

        .click-indicator {
            position: absolute;
            top: 1rem;
            right: 1rem;
            color: #2196f3;
            font-size: 1.2rem;
            font-weight: bold;
            opacity: 0.7;
            transition: opacity 0.3s ease;
        }

        .result-item.clickable:hover .click-indicator {
            opacity: 1;
            transform: scale(1.1);
        }

        .result-number {
            background: #2196f3;
            color: white;
            width: 2rem;
            height: 2rem;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
            flex-shrink: 0;
        }

        .result-content {
            flex: 1;
            min-width: 0;
            overflow: hidden;
        }

        .result-title {
            font-size: 1.1rem;
            margin-bottom: 0.5rem;
            color: #2196f3;
            word-wrap: break-word;
            overflow-wrap: break-word;
            line-height: 1.3;
        }

        .result-snippet {
            font-size: 0.9rem;
            color: #a0a0a0;
            margin-bottom: 0.5rem;
            line-height: 1.4;
            word-wrap: break-word;
            overflow-wrap: break-word;
            display: -webkit-box;
            -webkit-line-clamp: 3;
            -webkit-box-orient: vertical;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .result-url {
            font-size: 0.8rem;
            color: #10b981;
            word-wrap: break-word;
            overflow-wrap: break-word;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .result-item.clickable .result-url::after {
            content: ' ↗';
            color: #2196f3;
            font-weight: bold;
        }

        .images-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 1rem;
            max-width: 1000px;
            margin: 0 auto;
        }

        .image-item {
            background: rgba(255, 255, 255, 0.05);
            border-radius: 12px;
            overflow: hidden;
            border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .image-item img {
            width: 100%;
            height: 150px;
            object-fit: cover;
        }

        .image-caption {
            padding: 0.5rem;
            font-size: 0.8rem;
            color: #a0a0a0;
        }

        .recommendations-content {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
            gap: 2rem;
            max-width: 1000px;
            margin: 0 auto;
        }

        .recommendation-section {
            background: rgba(255, 255, 255, 0.05);
            padding: 1.5rem;
            border-radius: 12px;
            border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .recommendation-section h3 {
            color: #2196f3;
            margin-bottom: 1rem;
        }

        .recommendation-section ul {
            list-style: none;
        }

        .recommendation-section li {
            margin-bottom: 0.5rem;
            padding-left: 1rem;
            position: relative;
        }

        .recommendation-section li::before {
            content: '→';
            color: #2196f3;
            position: absolute;
            left: 0;
        }

        .navigation {
            position: fixed;
            bottom: 2rem;
            left: 50%;
            transform: translateX(-50%);
            display: flex;
            gap: 1rem;
            z-index: 1000;
        }

        .nav-btn {
            background: rgba(255, 255, 255, 0.1);
            border: 1px solid rgba(255, 255, 255, 0.2);
            color: #e0e0e0;
            padding: 0.75rem 1.5rem;
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.3s ease;
        }

        .nav-btn:hover {
            background: rgba(255, 255, 255, 0.2);
        }

        .nav-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .slide-counter {
            position: fixed;
            top: 2rem;
            right: 2rem;
            background: rgba(255, 255, 255, 0.1);
            padding: 0.5rem 1rem;
            border-radius: 8px;
            font-size: 0.9rem;
            color: #a0a0a0;
        }

        @media (max-width: 768px) {
            .slide {
                padding: 2rem;
            }
            
            .slide-title {
                font-size: 2rem;
            }
            
            .summary-text {
                font-size: 1.2rem;
            }
            
            .keypoints-list li {
                font-size: 1.1rem;
            }
        }
    </style>
</head>
<body>
    <div class="presentation-container">
        ${slides.join('')}
    </div>
    
    <div class="slide-counter">
        <span id="current-slide">1</span> / <span id="total-slides">${slides.length}</span>
    </div>
    
    <div class="navigation">
        <button class="nav-btn" id="prev-btn" onclick="previousSlide()">Previous</button>
        <button class="nav-btn" id="next-btn" onclick="nextSlide()">Next</button>
    </div>

    <script>
        let currentSlide = 0;
        const slides = document.querySelectorAll('.slide');
        const totalSlides = slides.length;
        
        function showSlide(index) {
            slides.forEach(slide => slide.classList.remove('active'));
            slides[index].classList.add('active');
            
            document.getElementById('current-slide').textContent = index + 1;
            document.getElementById('prev-btn').disabled = index === 0;
            document.getElementById('next-btn').disabled = index === totalSlides - 1;
        }
        
        function nextSlide() {
            if (currentSlide < totalSlides - 1) {
                currentSlide++;
                showSlide(currentSlide);
            }
        }
        
        function previousSlide() {
            if (currentSlide > 0) {
                currentSlide--;
                showSlide(currentSlide);
            }
        }
        
        // Function to open search results
        function openResult(url) {
            if (url && url !== '#') {
                window.open(url, '_blank');
            }
        }
        
        // Keyboard navigation
        document.addEventListener('keydown', function(e) {
            if (e.key === 'ArrowRight' || e.key === ' ') {
                nextSlide();
            } else if (e.key === 'ArrowLeft') {
                previousSlide();
            }
        });
        
        // Initialize
        showSlide(0);
    </script>
</body>
</html>
  `;
}

// Test search endpoint
app.post("/test/search", async (req, res) => {
  const query = req.body.query;
  try {
    // Validate input
    const validatedQuery = validateInput(query);

    // Let Claude decide if web search is needed
    let doWebSearch = true;
    try {
      doWebSearch = await shouldDoWebSearch(query);
    } catch (error) {
      logger.error('Claude API call failed for web search decision', error);
      // If Claude fails, default to web search for safety
      doWebSearch = true;
    }

    if (!doWebSearch) {
      // This is a conversational query - let Claude answer from its training data
      try {
        const message = await anthropic.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1024,
          temperature: 0.7,
          messages: [
            { role: "user", content: validatedQuery }
          ]
        });

        return res.json({
          message: message.content[0]?.text || "I'm sorry, I couldn't generate a response.",
          isConversational: true
        });
      } catch (apiError) {
        logger.error('Error getting conversational response from Claude', apiError);
        return res.status(500).json({
          error: 'Failed to get conversational response',
          isConversational: true
        });
      }
    }

    // Use RapidAPI for web and Pexels for image search with shorter timeout
    const searchTimeout = 15000; // 15 seconds instead of 30
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error(`Search timed out after ${searchTimeout}ms`)), searchTimeout)
    );

    let webResults, imageResults;
    try {
      [webResults, imageResults] = await Promise.race([
        Promise.all([
          searchClient.searchLocal({ q: validatedQuery }).catch(error => {
            logger.error('Web search failed:', { error: error.message, stack: error.stack });
            throw error;
          }),
          searchClient.searchImages({ q: validatedQuery }).catch(error => {
            logger.error('Image search failed:', { error: error.message, stack: error.stack });
            throw error;
          })
        ]),
        timeoutPromise
      ]);
    } catch (searchError) {
      logger.error('Search operation failed:', { 
        error: searchError.message, 
        stack: searchError.stack,
        query: validatedQuery 
      });
      throw searchError;
    }

    // imageResults is an object with image_results property (array)
    const processedImageResults = imageResults.image_results || imageResults.result || [];
    // Map Serper API's 'organic' results to the expected format
    let processedWebResults = [];
    if (webResults.result && Array.isArray(webResults.result)) {
      processedWebResults = webResults.result;
    } else if (webResults.organic && Array.isArray(webResults.organic)) {
      processedWebResults = webResults.organic.map(r => ({
        title: r.title,
        href: r.link,
        body: r.snippet
      }));
    } else {
      processedWebResults = [];
    }

    // Generate intelligent analysis response based on query type
    let llmResponse = null;
    let analysisResponse = null;
    let needsAnalysis = false;
    
    if (processedWebResults.length > 0) {
      try {
        // Let Claude decide if deep analysis is needed
        try {
          needsAnalysis = await shouldDoDeepAnalysis(validatedQuery);
          logger.info({ query: validatedQuery, needsAnalysis }, 'Analysis decision made');
        } catch (error) {
          logger.error('Claude API call failed for analysis decision', error);
          // If Claude fails, default to no analysis for safety
          needsAnalysis = false;
        }

        // Create context from web search results
        const contextPrompt = processedWebResults
          .slice(0, 5) // Use top 5 results
          .map(result => `Title: ${result.title}\nURL: ${result.href}\nSnippet: ${result.body}`)
          .join('\n\n');

        if (needsAnalysis) {
          logger.info('Generating deep analysis for query:', validatedQuery);
          // Generate deep analysis using structured prompt
          const analysisPrompt = `Based on the following web search results, provide a comprehensive analysis for: "${validatedQuery}"

Web Search Results:
${contextPrompt}

Please provide your response in the following JSON format:

{
  "summary": "A concise 2-3 sentence summary of the key findings",
  "keyPoints": [
    "Key point 1",
    "Key point 2", 
    "Key point 3"
  ],
  "tasks": [
    {
      "title": "Task Title",
      "description": "Detailed description of what needs to be done",
      "priority": "high|medium|low",
      "estimatedTime": "time estimate",
      "resources": ["resource1", "resource2"],
      "status": "pending"
    }
  ],
  "recommendations": [
    "Specific recommendation 1",
    "Specific recommendation 2"
  ],
  "context": {
    "background": "Background information",
    "currentTrends": "Current trends or developments",
    "challenges": ["Challenge 1", "Challenge 2"]
  }
}

Focus on providing actionable insights and practical tasks. Keep the summary concise and the key points clear.`;

          const analysisMessage = await anthropic.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 1500,
            temperature: 0.7,
            messages: [
              {
                role: "user",
                content: analysisPrompt
              }
            ]
          });

          const analysisText = analysisMessage.content[0]?.text || "";
          logger.info('Analysis response received, length:', analysisText.length);
          
          // Try to parse the JSON response
          try {
            const jsonMatch = analysisText.match(/```json\n([\s\S]*?)\n```/) || analysisText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const jsonContent = jsonMatch[1] || jsonMatch[0];
              analysisResponse = JSON.parse(jsonContent.trim());
              logger.info('Analysis JSON parsed successfully:', Object.keys(analysisResponse));
            } else {
              // Fallback to regular text response
              logger.warn('No JSON found in analysis response, using as text');
              llmResponse = analysisText;
            }
          } catch (parseError) {
            // If JSON parsing fails, use as regular text
            logger.error('Failed to parse analysis JSON:', parseError.message);
            llmResponse = analysisText;
          }
        }

        // Generate a regular LLM response for the chat panel
        const regularMessage = await anthropic.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1024,
          temperature: 0.7,
          messages: [
            {
              role: "user",
              content: `Based on the following web search results, please provide a comprehensive answer to the user's question: "${validatedQuery}"\n\nWeb Search Results:\n${contextPrompt}\n\nPlease provide a well-structured response that directly answers the user's question using the information from the search results.`
            }
          ]
        });

        llmResponse = regularMessage.content[0]?.text || "I found some information but couldn't generate a proper response.";
      } catch (llmError) {
        logger.error('Error generating LLM response from web results:', llmError);
        llmResponse = `I found ${processedWebResults.length} web results for your query. You can view them in the panel on the right.`;
      }
    }

    const responseData = {
      webResults: processedWebResults,
      imageResults: processedImageResults,
      llmResponse: llmResponse,
      analysisResponse: analysisResponse,
      needsAnalysis: needsAnalysis,
      isConversational: false
    };
    
    logger.info('Sending response to frontend:', {
      needsAnalysis: responseData.needsAnalysis,
      hasAnalysisResponse: !!responseData.analysisResponse,
      analysisKeys: responseData.analysisResponse ? Object.keys(responseData.analysisResponse) : null
    });
    
    res.json(responseData);
  } catch (error) {
    logger.error('Error in /test/search:', error);
    res.status(500).json({ error: error.message, isConversational: false });
  }
});

// Helper function to create template data based on complexity
function createTemplateData(query, analysisData, textResults, searchResults, complexity) {
  // Get web search results and image results
  const webResults = textResults.organic_results?.slice(0, 6) || [];
  const imageResults = searchResults.image_results?.slice(0, 6) || [];
  
  console.log('Debug - searchResults structure:', Object.keys(searchResults));
  console.log('Debug - imageResults:', imageResults);
  console.log('Debug - webResults:', webResults);
  
  // Combine web results with corresponding images
  const searchResultsWithImages = webResults.map((result, index) => ({
    ...result,
    images: imageResults[index] ? [imageResults[index]] : []
  }));

  console.log('Debug - searchResultsWithImages:', searchResultsWithImages.map(r => ({ title: r.title, hasImages: r.images.length > 0 })));

  const baseData = {
    query,
    result: {
      query,
      analysis: {
        summary: analysisData.summary,
        keyPoints: analysisData.keyPoints,
        analysis: analysisData.analysis
      },
      searchResults: searchResultsWithImages,
      images: imageResults,
      complexity: complexity.level
    }
  };

  // Add complexity-specific data
  if (complexity.level !== 'simple') {
    baseData.result.analysis.context = {
      ...analysisData.context,
      misconceptions: analysisData.context?.misconceptions || [] // Ensure misconceptions is always an array
    };
  }

  if (complexity.level === 'deep') {
    baseData.result.analysis.recommendations = analysisData.recommendations;
  }

  return baseData;
}

const parseAnthropicResponse = async (response) => {
  try {
    // Validate response structure
    if (!response || !Array.isArray(response.content) || response.content.length === 0) {
      throw new Error("Invalid response structure: missing content array");
    }

    const contentItem = response.content[0];
    if (!contentItem || typeof contentItem.text !== 'string') {
      throw new Error("Invalid content item: missing or invalid text");
    }

    const rawText = contentItem.text;
    
    // Find JSON content between code blocks or standalone
    const jsonMatch = rawText.match(/```json\n([\s\S]*?)\n```/) || rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON content found in response");
    }
    
    // Use the content from within code blocks if found, otherwise use the full match
    const jsonContent = jsonMatch[1] || jsonMatch[0];
    
    const analysisData = JSON.parse(jsonContent.trim());
    
    // Validate expected data structure
    if (!analysisData || typeof analysisData !== 'object') {
      throw new Error("Parsed content is not an object");
    }
    
    if (!analysisData.summary || !analysisData.keyPoints) {
      throw new Error("Missing required fields in analysis data");
    }
    return analysisData;
  } catch (error) {
    logger.error({ 
      error: error.message,
      rawResponse: response,
      parsedContent: response?.content
    }, "Failed to parse Anthropic response");
    throw new Error(`Failed to process analysis results: ${error.message}`);
  }
};

const performSearch = async (query) => {
  const timeoutPromise = new Promise((_, reject) => 
    setTimeout(() => reject(new Error("Request timed out")), 30000)
  );

  // Set up base parameters with proper engine specification
  const baseParams = {
    q: query,
    engine: "google",
    google_domain: "google.co.in",
    gl: "in",
    hl: "en",
    safe: "active",
    num: 10
  };

  // Extract location if present
  const locationMatch = query.match(/\b(?:in|at|near)\s+([^,]+)(?:,\s*([^,]+))?(?:,\s*([^,]+))?\b/i);
  if (locationMatch) {
    // Location is already in the query, just add a flag
    baseParams.location_requested = true;
  }

  // Create copies for both search types to avoid parameter conflicts
  const imageBaseParams = { ...baseParams };
  const webBaseParams = { ...baseParams };
  
  return Promise.race([
    Promise.all([
      handleSerpApiRequest('images', imageBaseParams),  // Image search parameters
      handleSerpApiRequest('web', webBaseParams)  // Web search parameters
    ]),
    timeoutPromise
  ]);
};

async function callClaude(query, contextPrompt) {
  const prompt = generateSystemPrompt(query, contextPrompt);
  const message = await anthropic.messages.create({
    model: validateModel("claude-sonnet-4-20250514"),
    max_tokens: 1024,
    temperature: 0.5,
    system: prompt,
    messages: [
      { role: "user", content: `Search query: "${query}"\n\nNow analyze based on above system prompt.` }
    ]
  });

  return message.content;
}

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocketServer({ server });

// Store connected clients
const clients = new Set();

// WebSocket connection handler
wss.on('connection', (ws) => {
    console.log('New WebSocket client connected');
    clients.add(ws);
    
    // Send initial connection message
    ws.send(JSON.stringify({
        type: 'connection',
        message: 'Connected to backend terminal',
        timestamp: new Date().toISOString()
    }));
    
    ws.on('close', () => {
        console.log('WebSocket client disconnected');
        clients.delete(ws);
    });
    
    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        clients.delete(ws);
    });
});

// Function to broadcast messages to all connected clients
function broadcastToTerminal(data) {
    const message = JSON.stringify({
        ...data,
        timestamp: new Date().toISOString()
    });
    
    clients.forEach(client => {
        if (client.readyState === 1) { // WebSocket.OPEN
            try {
                client.send(message);
            } catch (error) {
                console.error('Error sending message to client:', error);
                clients.delete(client);
            }
        }
    });
}

// Set the broadcast function in the assistant module
setBroadcastFunction(broadcastToTerminal);

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    logger.info(`Server is running on port ${PORT}`);
    console.log(`Server is running on http://localhost:${PORT}/test`);
});
