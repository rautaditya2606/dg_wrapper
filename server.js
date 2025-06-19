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
import { chat, formatAIResponse } from './src/assistant.js';
import { RapidAPISearchClient } from './src/search.js';

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
const searchClient = new RapidAPISearchClient(process.env.RAPIDAPI_KEY);

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
          images: searchResults.images_results?.slice(0, 4) || [],
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

// Helper function to determine if web search is needed
// This is now just a fallback in case Claude API fails
function needsWebSearch(query) {
  // Always do web search for queries that seem to request facts or information
  const informationPatterns = [
    /how\s+to/i,
    /what\s+is/i,
    /when\s+was/i,
    /where\s+is/i,
    /who\s+is/i,
    /why\s+does/i,
    /latest/i,
    /news/i,
    /update/i,
    /example/i,
    /guide/i,
    /tutorial/i,
    /search/i,
    /find/i,
    /restaurant/i,
    /food/i,
    /place/i
  ];

  return informationPatterns.some(pattern => pattern.test(query));
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
      logger.warn('Claude API call failed, falling back to pattern matching', {
        error: error.message,
        stack: error.stack
      });
      doWebSearch = needsWebSearch(query);
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
    const isConversational = !needsWebSearch(query);
    res.status(500).json({ 
      error: error.message,
      isConversational
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

// Initialize the RapidAPI search client for /test
const rapidApiSearchClient = new RapidAPISearchClient(process.env.RAPIDAPI_KEY);

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
      logger.warn('Claude API call failed, falling back to pattern matching', error);
      doWebSearch = needsWebSearch(query);
    }

    if (!doWebSearch) {
      return res.json({
        message: "This appears to be a conversational query. Use /analyze for chat.",
        isConversational: true
      });
    }

    // Use RapidAPI for web and image search
    const [webResults, imageResults] = await Promise.all([
      rapidApiSearchClient.searchLocal({ q: validatedQuery }),
      rapidApiSearchClient.searchImages({ q: validatedQuery })
    ]);

    res.json({
      query: validatedQuery,
      webResults: webResults.organic_results || [],
      imageResults: imageResults.image_results || [],
      isConversational: false
    });
  } catch (error) {
    logger.error('Test search error:', error);
    res.status(500).json({
      error: error.message,
      isConversational: false
    });
  }
});

// Helper function to create template data based on complexity
function createTemplateData(query, analysisData, textResults, searchResults, complexity) {
  const baseData = {
    query,
    result: {
      query,
      analysis: {
        summary: analysisData.summary,
        keyPoints: analysisData.keyPoints,
        analysis: analysisData.analysis
      },
      searchResults: textResults.organic_results?.slice(0, 3) || [],
      images: searchResults.images_results?.slice(0, 4) || [],
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    logger.info(`Server is running on port ${PORT}`);
    console.log(`Server is running on http://localhost:${PORT}`);
});
