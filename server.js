require("dotenv").config();
require('dns').setDefaultResultOrder('ipv4first');  // Prioritize IPv4
process.env.UV_THREADPOOL_SIZE = 16;  // Increase thread pool for better network handling

// Force IPv4 globally
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const http = require('http');
const https = require('https');

// Force IPv4 for all HTTP/HTTPS connections
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

const express = require("express");
const path = require("path");
const SerpApi = require("google-search-results-nodejs");
const Anthropic = require('@anthropic-ai/sdk');
const rateLimit = require('express-rate-limit');
const pino = require('pino')();
const HttpsProxyAgent = require('https-proxy-agent');

// Add API key validation logging
console.log('API Key format check:', process.env.ANTHROPIC_API_KEY?.startsWith('sk-ant-'));
console.log('API Key length:', process.env.ANTHROPIC_API_KEY?.length);

const app = express();
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY?.trim(),
});
const search = new SerpApi.GoogleSearch(process.env.SERPAPI_API_KEY);
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

// Handle SerpApi request with enhanced error handling and retry logic
const handleSerpApiRequest = async (params) => {
  const options = {
    timeout: 10000,  // 10 second timeout per attempt
    retries: 3,      // Maximum 3 retries
    backoff: (retryCount) => Math.min(1000 * Math.pow(2, retryCount), 10000) // Exponential backoff
  };

  return withRetry(
    () =>
      new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(new Error(`SerpAPI request timed out after ${options.timeout}ms`));
        }, options.timeout);

        search.json(
          params,
          (result) => {
            clearTimeout(timeoutId);
            resolve(result);
          },
          (error) => {
            clearTimeout(timeoutId);
            pino.error({
              error: error.message,
              params,
              code: error.code
            }, 'SerpAPI request failed');
            reject(error);
          }
        );
      }),
    options.retries,
    (retryCount) => options.backoff(retryCount)
  );
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

// Replace the existing /search route with this updated version
app.post("/search", async (req, res) => {
  const query = req.body.query;
  
  try {
    // Validate input
    const validatedQuery = validateInput(query);
    
    // Analyze query complexity
    const complexity = analyzeQueryComplexity(validatedQuery);
    pino.info({ query: validatedQuery, complexity }, 'Query complexity analysis');
    
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

    // Parse response safely
    const analysisData = await parseAnthropicResponse(anthropicResponse);

    // Create template data based on complexity level
    const templateData = createTemplateData(validatedQuery, analysisData, textResults, searchResults, complexity);

    try {
      res.render("index", templateData);
    } catch (renderError) {
      pino.error({ 
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
    pino.error({ 
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

// New POST /analyze route
app.post("/analyze", async (req, res) => {
  try {
    const query = validateInput(req.body.query);
    const complexity = analyzeQueryComplexity(query);
    const serpResults = await handleSerpApiRequest({ q: query, api_key: process.env.SERPAPI_API_KEY });

    const contextPrompt = generateSystemPrompt(query, complexity);
    const structuredAnswer = await callClaude(query, contextPrompt);

    res.json({
      query,
      complexity,
      structuredAnswer
    });
  } catch (err) {
    pino.error(err, 'Error in /analyze');
    res.status(500).json({ error: err.message });
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
    pino.error({ 
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

  return Promise.race([
    Promise.all([
      handleSerpApiRequest({
        q: query,
        engine: "google",
        tbm: "isch",
        num: 10,
      }),
      handleSerpApiRequest({
        q: query,
        engine: "google",
      })
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
  console.log(`Server started on http://localhost:${PORT}`);
  
  // Verify IPv4 configuration
  dns.lookup('serpapi.com', { family: 4 }, (err, address, family) => {
    if (err) {
      pino.error({ error: err }, 'Failed to resolve serpapi.com');
    } else {
      pino.info({ address, family }, 'Successfully resolved serpapi.com using IPv4');
    }
  });
});
