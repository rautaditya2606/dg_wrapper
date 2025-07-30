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

// Add global error handlers to catch any unhandled errors
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ UNHANDLED REJECTION:', reason);
  console.error('Promise:', promise);
});
process.on('uncaughtException', (err) => {
  console.error('❌ UNCAUGHT EXCEPTION:', err);
});

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
      model: "claude-3-opus-20240229",
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
    model: "claude-3-opus-20240229",
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
    model: "claude-3-opus-20240229",
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
      logger.error({ error: error.message, stack: error.stack, anthropicData: error.response?.data, query }, 'Claude API call failed for web search decision');
      console.error('FULL CLAUDE ERROR:', error, error?.response?.data);
      // If Claude fails, default to web search for safety
      doWebSearch = true;
    }

    if (!doWebSearch) {
      try {
        const message = await anthropic.messages.create({
          model: "claude-3-opus-20240229",
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
        model: "claude-3-opus-20240229",
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
          model: "claude-3-opus-20240229",
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
            model: "claude-3-opus-20240229",
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
          model: "claude-3-opus-20240229",
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

// Download slides endpoint
app.post("/download-slides", async (req, res) => {
  try {
    const { query, llmResponse, analysisResponse, webResults, imageResults, timestamp } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    // Generate HTML slides
    const htmlContent = generateSlidesHtml(query, llmResponse, analysisResponse, webResults, imageResults, timestamp);
    
    // Set headers for file download
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `attachment; filename="${query.replace(/[^a-zA-Z0-9]/g, '_')}_slides.html"`);
    
    res.send(htmlContent);
  } catch (error) {
    logger.error('Error generating slides:', error);
    res.status(500).json({ error: 'Failed to generate slides' });
  }
});

// Format LLM response for template
function formatLLMResponseForTemplate(response) {
  if (!response) return '<p>No general analysis available.</p>';
  
  let formatted = response
    // Handle escaped characters
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, '\\')
    
    // Convert markdown-style headers to HTML
    .replace(/^### (.*$)/gim, '<h3>$1</h3>')
    .replace(/^## (.*$)/gim, '<h2>$1</h2>')
    .replace(/^# (.*$)/gim, '<h1>$1</h1>')
    
    // Convert bold text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.*?)__/g, '<strong>$1</strong>')
    
    // Convert italic text
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/_(.*?)_/g, '<em>$1</em>')
    
    // Convert code blocks
    .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    
    // Convert blockquotes
    .replace(/^> (.*$)/gim, '<blockquote>$1</blockquote>')
    
    // Convert lists
    .replace(/^\d+\. (.*$)/gim, '<li>$1</li>')
    .replace(/^- (.*$)/gim, '<li>$1</li>')
    .replace(/^\* (.*$)/gim, '<li>$1</li>')
    
    // Convert line breaks to paragraphs
    .split('\n\n')
    .map(paragraph => {
      paragraph = paragraph.trim();
      if (!paragraph) return '';
      
      // If it's already an HTML tag, don't wrap it
      if (paragraph.startsWith('<')) {
        return paragraph;
      }
      
      // If it contains list items, wrap in ul/ol
      if (paragraph.includes('<li>')) {
        // Check if it's numbered list
        const isNumbered = /\d+\./.test(paragraph);
        const listType = isNumbered ? 'ol' : 'ul';
        return `<${listType}>${paragraph}</${listType}>`;
      }
      
      // Otherwise wrap in paragraph
      return `<p>${paragraph}</p>`;
    })
    .join('');
  
  return formatted;
}

// Format LLM response for better presentation
function formatLLMResponse(response) {
  if (!response) return '<p>No response available.</p>';
  
  let formatted = response
    // Handle escaped characters
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, '\\')
    
    // Convert markdown-style headers to HTML
    .replace(/^### (.*$)/gim, '<h3>$1</h3>')
    .replace(/^## (.*$)/gim, '<h2>$1</h2>')
    .replace(/^# (.*$)/gim, '<h1>$1</h1>')
    
    // Convert bold text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.*?)__/g, '<strong>$1</strong>')
    
    // Convert italic text
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/_(.*?)_/g, '<em>$1</em>')
    
    // Convert code blocks
    .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    
    // Convert blockquotes
    .replace(/^> (.*$)/gim, '<blockquote>$1</blockquote>')
    
    // Convert lists
    .replace(/^\d+\. (.*$)/gim, '<li>$1</li>')
    .replace(/^- (.*$)/gim, '<li>$1</li>')
    .replace(/^\* (.*$)/gim, '<li>$1</li>')
    
    // Convert line breaks to paragraphs
    .split('\n\n')
    .map(paragraph => {
      paragraph = paragraph.trim();
      if (!paragraph) return '';
      
      // If it's already an HTML tag, don't wrap it
      if (paragraph.startsWith('<')) {
        return paragraph;
      }
      
      // If it contains list items, wrap in ul/ol
      if (paragraph.includes('<li>')) {
        // Check if it's numbered list
        const isNumbered = /\d+\./.test(paragraph);
        const listType = isNumbered ? 'ol' : 'ul';
        return `<${listType}>${paragraph}</${listType}>`;
      }
      
      // Otherwise wrap in paragraph
      return `<p>${paragraph}</p>`;
    })
    .join('');
  
  return formatted;
}

// Generate formatted LLM response HTML
function generateFormattedLLMResponse(llmResponse) {
  if (!llmResponse) return '<p>No general analysis available.</p>';
  
  let formatted = llmResponse
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, '\\')
    .replace(/^### (.*$)/gim, '<h3>$1</h3>')
    .replace(/^## (.*$)/gim, '<h2>$1</h2>')
    .replace(/^# (.*$)/gim, '<h1>$1</h1>')
    .replace(/\\*\\*(.*?)\\*\\*/g, '<strong>$1</strong>')
    .replace(/__(.*?)__/g, '<strong>$1</strong>')
    .replace(/\\*(.*?)\\*/g, '<em>$1</em>')
    .replace(/_(.*?)_/g, '<em>$1</em>')
    .replace(/```([\\s\\S]*?)```/g, '<pre><code>$1</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^> (.*$)/gim, '<blockquote>$1</blockquote>')
    .replace(/^\\d+\\. (.*$)/gim, '<li>$1</li>')
    .replace(/^- (.*$)/gim, '<li>$1</li>')
    .replace(/^\\* (.*$)/gim, '<li>$1</li>')
    .split('\\n\\n')
    .map(p => p.trim())
    .filter(p => p)
    .map(p => p.startsWith('<') ? p : `<p>${p}</p>`)
    .join('');
  
  return formatted;
}

// Generate HTML slides function
function generateSlidesHtml(query, llmResponse, analysisResponse, webResults, imageResults, timestamp) {
  const date = new Date(timestamp);
  const formattedDate = date.toLocaleDateString();
  const formattedTime = date.toLocaleTimeString();
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${query} - Analysis Slides</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #333;
            line-height: 1.6;
            overflow-x: hidden;
        }
        
        .slide {
            width: 100vw;
            height: 100vh;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            padding: 60px;
            position: relative;
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(10px);
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
        }
        
        .slide-content {
            max-width: 1200px;
            width: 100%;
            text-align: center;
        }
        
        .slide-title {
            font-size: 3rem;
            font-weight: 700;
            color: #2c3e50;
            margin-bottom: 2rem;
            text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.1);
        }
        
        .slide-subtitle {
            font-size: 1.5rem;
            color: #7f8c8d;
            margin-bottom: 3rem;
        }
        
        .slide-text {
            font-size: 1.2rem;
            color: #34495e;
            max-width: 900px;
            margin: 0 auto;
            text-align: left;
            line-height: 1.8;
        }
        
        .slide-text p {
            margin-bottom: 1.5rem;
            text-align: justify;
        }
        
        .slide-text h1, .slide-text h2, .slide-text h3 {
            color: #2c3e50;
            margin: 2rem 0 1rem 0;
            font-weight: 600;
        }
        
        .slide-text h1 {
            font-size: 1.8rem;
            border-bottom: 2px solid #3498db;
            padding-bottom: 0.5rem;
        }
        
        .slide-text h2 {
            font-size: 1.5rem;
            color: #2980b9;
        }
        
        .slide-text h3 {
            font-size: 1.3rem;
            color: #34495e;
        }
        
        .slide-text ul, .slide-text ol {
            margin: 1rem 0 1.5rem 2rem;
            padding-left: 1rem;
        }
        
        .slide-text li {
            margin-bottom: 0.8rem;
            line-height: 1.6;
        }
        
        .slide-text blockquote {
            border-left: 4px solid #3498db;
            background: #ecf0f1;
            padding: 1.5rem;
            margin: 1.5rem 0;
            border-radius: 8px;
            font-style: italic;
        }
        
        .slide-text strong {
            color: #e74c3c;
            font-weight: 600;
        }
        
        .slide-text em {
            color: #27ae60;
            font-style: italic;
        }
        
        .slide-text code {
            background: #2c3e50;
            color: #ecf0f1;
            padding: 0.3rem 0.6rem;
            border-radius: 4px;
            font-family: 'Courier New', monospace;
            font-size: 0.9rem;
        }
        
        .slide-text pre {
            background: #2c3e50;
            color: #ecf0f1;
            padding: 1.5rem;
            border-radius: 8px;
            overflow-x: auto;
            margin: 1.5rem 0;
            border: 1px solid #34495e;
        }
        
        .slide-text pre code {
            background: none;
            padding: 0;
            color: inherit;
        }
        
        .slide-text h1, .slide-text h2, .slide-text h3 {
            color: #2c3e50;
            margin: 1rem 0 0.5rem 0;
        }
        
        .slide-text ul, .slide-text ol {
            margin: 1rem 0;
            padding-left: 2rem;
        }
        
        .slide-text li {
            margin-bottom: 0.5rem;
        }
        
        .slide-text pre {
            background: #2c3e50;
            color: #ecf0f1;
            padding: 1rem;
            border-radius: 8px;
            overflow-x: auto;
            margin: 1rem 0;
        }
        
        .slide-text code {
            background: #34495e;
            color: #ecf0f1;
            padding: 0.2rem 0.4rem;
            border-radius: 4px;
            font-family: 'Courier New', monospace;
        }
        
        .slide-text blockquote {
            border-left: 4px solid #3498db;
            background: #ecf0f1;
            padding: 1rem;
            margin: 1rem 0;
            border-radius: 8px;
        }
        
        .slide-text strong {
            color: #e74c3c;
        }
        
        .slide-text em {
            color: #27ae60;
        }
        
        .card {
            background: white;
            border-radius: 12px;
            padding: 2rem;
            margin: 1rem 0;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
            border: 1px solid #e1e8ed;
        }
        
        .card h3 {
            color: #2c3e50;
            margin-bottom: 1rem;
            font-size: 1.5rem;
        }
        
        .card p {
            color: #34495e;
            margin-bottom: 1rem;
        }
        
        .key-points {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 1.5rem;
            margin: 2rem 0;
        }
        
        .key-point {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 1.5rem;
            border-radius: 12px;
            text-align: center;
        }
        
        .key-point h4 {
            margin-bottom: 1rem;
            font-size: 1.2rem;
        }
        
        .web-results {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
            gap: 1.5rem;
            margin: 2rem 0;
        }
        
        .web-result {
            background: white;
            border-radius: 12px;
            padding: 1.5rem;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
            border: 1px solid #e1e8ed;
            transition: transform 0.3s ease;
        }
        
        .web-result:hover {
            transform: translateY(-5px);
        }
        
        .web-result h4 {
            color: #2c3e50;
            margin-bottom: 0.5rem;
            font-size: 1.1rem;
        }
        
        .web-result p {
            color: #7f8c8d;
            margin-bottom: 0.5rem;
            font-size: 0.9rem;
        }
        
        .web-result a {
            color: #3498db;
            text-decoration: none;
            font-size: 0.8rem;
        }
        
        .web-result a:hover {
            text-decoration: underline;
        }
        
        .image-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 1.5rem;
            margin: 2rem 0;
        }
        
        .image-item {
            background: white;
            border-radius: 12px;
            overflow: hidden;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
            transition: transform 0.3s ease;
        }
        
        .image-item:hover {
            transform: translateY(-5px);
        }
        
        .image-item img {
            width: 100%;
            height: 200px;
            object-fit: cover;
            border-radius: 8px 8px 0 0;
            background: #f8f9fa;
            transition: opacity 0.3s ease;
        }
        
        .image-item img[src=""], .image-item img:not([src]) {
            display: none;
        }
        
        .image-info {
            padding: 1rem;
        }
        
        .image-info h4 {
            color: #2c3e50;
            margin-bottom: 0.5rem;
            font-size: 1rem;
        }
        
        .image-info a {
            color: #3498db;
            text-decoration: none;
            font-size: 0.8rem;
        }
        
        .image-info a:hover {
            text-decoration: underline;
        }
        
        .navigation {
            position: fixed;
            bottom: 30px;
            left: 50%;
            transform: translateX(-50%);
            display: flex;
            gap: 1rem;
            z-index: 1000;
        }
        
        .nav-btn {
            background: #2c3e50;
            color: white;
            border: none;
            padding: 0.8rem 1.5rem;
            border-radius: 25px;
            cursor: pointer;
            font-size: 1rem;
            transition: all 0.3s ease;
            box-shadow: 0 4px 15px rgba(0, 0, 0, 0.2);
        }
        
        .nav-btn:hover {
            background: #34495e;
            transform: translateY(-2px);
        }
        
        .nav-btn:disabled {
            background: #bdc3c7;
            cursor: not-allowed;
            transform: none;
        }
        
        .slide-counter {
            position: fixed;
            top: 30px;
            right: 30px;
            background: rgba(44, 62, 80, 0.9);
            color: white;
            padding: 0.5rem 1rem;
            border-radius: 20px;
            font-size: 0.9rem;
        }
        
        .slide {
            display: none;
        }
        
        .slide.active {
            display: flex;
        }
        
        @media (max-width: 768px) {
            .slide {
                padding: 30px;
            }
            
            .slide-title {
                font-size: 2rem;
            }
            
            .slide-subtitle {
                font-size: 1.2rem;
            }
            
            .slide-text {
                font-size: 1rem;
            }
            
            .key-points {
                grid-template-columns: 1fr;
            }
            
            .web-results {
                grid-template-columns: 1fr;
            }
            
            .image-grid {
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            }
        }
    </style>
</head>
<body>
    <div class="slide-counter">
        <span id="current-slide">1</span> / <span id="total-slides">5</span>
    </div>
    
    <!-- Slide 1: Query -->
    <div class="slide active" id="slide-1">
        <div class="slide-content">
            <h1 class="slide-title">Query</h1>
            <div class="card">
                <h3>Your Question</h3>
                <p style="font-size: 1.5rem; color: #2c3e50; margin: 2rem 0;">"${query}"</p>
                <p style="color: #7f8c8d; font-size: 0.9rem;">Generated on ${formattedDate} at ${formattedTime}</p>
            </div>
        </div>
    </div>
    
    <!-- Slide 2: General LLM Response -->
    <div class="slide" id="slide-2">
        <div class="slide-content">
            <h1 class="slide-title">General Analysis</h1>
            <div class="slide-text">
                ${generateFormattedLLMResponse(llmResponse)}
            </div>
        </div>
    </div>
    
    <!-- Slide 3: Deep Analysis -->
    <div class="slide" id="slide-3">
        <div class="slide-content">
            <h1 class="slide-title">Deep Analysis</h1>
            ${analysisResponse ? `
                <div class="card">
                    ${analysisResponse.summary ? `
                        <h3>Summary</h3>
                        <p>${analysisResponse.summary}</p>
                    ` : ''}
                    
                    ${analysisResponse.keyPoints && analysisResponse.keyPoints.length > 0 ? `
                        <h3>Key Points</h3>
                        <div class="key-points">
                            ${analysisResponse.keyPoints.map(point => `
                                <div class="key-point">
                                    <h4>${point}</h4>
                                </div>
                            `).join('')}
                        </div>
                    ` : ''}
                    
                    ${analysisResponse.tasks && analysisResponse.tasks.length > 0 ? `
                        <h3>Action Items</h3>
                        ${analysisResponse.tasks.map(task => `
                            <div class="card">
                                <h4>${task.title || 'Task'}</h4>
                                <p><strong>Description:</strong> ${task.description || 'No description'}</p>
                                ${task.priority ? `<p><strong>Priority:</strong> ${task.priority}</p>` : ''}
                                ${task.estimatedTime ? `<p><strong>Estimated Time:</strong> ${task.estimatedTime}</p>` : ''}
                                ${task.resources && task.resources.length > 0 ? `
                                    <p><strong>Resources:</strong> ${task.resources.join(', ')}</p>
                                ` : ''}
                            </div>
                        `).join('')}
                    ` : ''}
                    
                    ${analysisResponse.recommendations && analysisResponse.recommendations.length > 0 ? `
                        <h3>Recommendations</h3>
                        ${analysisResponse.recommendations.map(rec => `
                            <div class="card">
                                <p>${rec}</p>
                            </div>
                        `).join('')}
                    ` : ''}
                    
                    ${analysisResponse.context ? `
                        <h3>Context & Background</h3>
                        ${analysisResponse.context.background ? `
                            <div class="card">
                                <h4>Background</h4>
                                <p>${analysisResponse.context.background}</p>
                            </div>
                        ` : ''}
                        ${analysisResponse.context.currentTrends ? `
                            <div class="card">
                                <h4>Current Trends</h4>
                                <p>${analysisResponse.context.currentTrends}</p>
                            </div>
                        ` : ''}
                        ${analysisResponse.context.challenges && analysisResponse.context.challenges.length > 0 ? `
                            <div class="card">
                                <h4>Challenges</h4>
                                <ul>
                                    ${analysisResponse.context.challenges.map(challenge => `<li>${challenge}</li>`).join('')}
                                </ul>
                            </div>
                        ` : ''}
                    ` : ''}
                </div>
            ` : '<div class="card"><p>No deep analysis available.</p></div>'}
        </div>
    </div>
    
    <!-- Slide 4: Web Results -->
    <div class="slide" id="slide-4">
        <div class="slide-content">
            <h1 class="slide-title">Web Search Results</h1>
            ${webResults && webResults.length > 0 ? `
                <div class="web-results">
                    ${webResults.slice(0, 6).map(result => `
                        <div class="web-result">
                            <h4>${result.title || 'No title'}</h4>
                            <p>${result.body || result.snippet || 'No description'}</p>
                            <a href="${result.href || result.link || '#'}" target="_blank" onclick="openResult('${result.href || result.link || '#'}')">
                                ${result.href || result.link || 'View source'}
                            </a>
                        </div>
                    `).join('')}
                </div>
            ` : '<div class="card"><p>No web search results available.</p></div>'}
        </div>
    </div>
    
    <!-- Slide 5: Image Results -->
    <div class="slide" id="slide-5">
        <div class="slide-content">
            <h1 class="slide-title">Image Results</h1>
            ${imageResults && imageResults.length > 0 ? `
                <div class="image-grid">
                    ${imageResults.slice(0, 8).map(image => {
                        // Handle different image data structures
                        const imageUrl = image.src || image.url || image.link || image.image || image.original || '';
                        const imageTitle = image.title || image.alt || 'Image';
                        const sourceUrl = image.href || image.source || image.url || image.link || '';
                        
                        return `
                            <div class="image-item">
                                <img src="${imageUrl}" alt="${imageTitle}" onerror="this.style.display='none'; this.nextElementSibling.innerHTML='<p style=\\"color: #999; text-align: center; padding: 2rem;\\">Image not available</p>';" onload="this.style.opacity='1'" style="opacity: 0; transition: opacity 0.3s ease;">
                                <div class="image-info">
                                    <h4>${imageTitle}</h4>
                                    ${sourceUrl ? `<a href="${sourceUrl}" target="_blank" onclick="openResult('${sourceUrl}')">View source</a>` : ''}
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            ` : '<div class="card"><p>No image results available.</p></div>'}
        </div>
    </div>
    
    <div class="navigation">
        <button class="nav-btn" id="prev-btn" onclick="previousSlide()">Previous</button>
        <button class="nav-btn" id="next-btn" onclick="nextSlide()">Next</button>
    </div>
    
    <script>
        let currentSlide = 1;
        const totalSlides = 5;
        
        function showSlide(slideNumber) {
            // Hide all slides
            for (let i = 1; i <= totalSlides; i++) {
                document.getElementById('slide-' + i).classList.remove('active');
            }
            
            // Show current slide
            document.getElementById('slide-' + slideNumber).classList.add('active');
            
            // Update counter
            document.getElementById('current-slide').textContent = slideNumber;
            document.getElementById('total-slides').textContent = totalSlides;
            
            // Update navigation buttons
            document.getElementById('prev-btn').disabled = slideNumber === 1;
            document.getElementById('next-btn').disabled = slideNumber === totalSlides;
        }
        
        function nextSlide() {
            if (currentSlide < totalSlides) {
                currentSlide++;
                showSlide(currentSlide);
            }
        }
        
        function previousSlide() {
            if (currentSlide > 1) {
                currentSlide--;
                showSlide(currentSlide);
            }
        }
        
        function openResult(url) {
            if (url && url !== '#') {
                window.open(url, '_blank');
            }
        }
        
        // Keyboard navigation
        document.addEventListener('keydown', function(event) {
            if (event.key === 'ArrowRight' || event.key === ' ') {
                nextSlide();
            } else if (event.key === 'ArrowLeft') {
                previousSlide();
            }
        });
        
        // Initialize
        showSlide(1);
    </script>
</body>
</html>`;
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
