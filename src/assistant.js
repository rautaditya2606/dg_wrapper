    // Import required dependencies
    import dotenv from 'dotenv';
    dotenv.config();
    import { ChatAnthropic } from '@langchain/anthropic';
    // Removed: import { SerpAPI } from '@langchain/community/tools/serpapi';
    import { BufferMemory } from 'langchain/memory';
    import { AgentExecutor, initializeAgentExecutorWithOptions } from 'langchain/agents';
    import { PromptTemplate } from '@langchain/core/prompts';
    import { RunnableSequence } from '@langchain/core/runnables';
    import { StringOutputParser } from '@langchain/core/output_parsers';
    import { WikipediaQueryRun } from '@langchain/community/tools/wikipedia_query_run';
    import axios from 'axios';
    import * as cheerio from 'cheerio';
    import { EventEmitter } from 'events';
    import { SearchClient } from './search.js';

    // Helper function to get current date
    const getCurrentDate = () => {
        const now = new Date();
        return now.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
    };

    // Create event emitter for web activities
    const webActivityEmitter = new EventEmitter();

    // Global function to broadcast to terminal (will be set by server)
    let broadcastToTerminal = null;

    // Function to set the broadcast function from server
    export function setBroadcastFunction(broadcastFn) {
        broadcastToTerminal = broadcastFn;
    }

    // Helper function to send activity to terminal
    function sendToTerminal(activity) {
        if (broadcastToTerminal) {
            broadcastToTerminal({
                type: 'backend_activity',
                activity: activity
            });
        }
    }

    // Helper function to get webpage metadata
    async function getPageMetadata(url) {
        try {
            const response = await axios.get(url, {
                timeout: 5000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            const $ = cheerio.load(response.data);
            
            // Get page title
            const title = $('title').text() || $('meta[property="og:title"]').attr('content') || '';
            
            // Try to get thumbnail
            const thumbnail = $('meta[property="og:image"]').attr('content') || 
                            $('meta[name="twitter:image"]').attr('content') ||
                            $('link[rel="image_src"]').attr('href');
                            
            return { thumbnail, title };
        } catch (error) {
            console.error(`Failed to get metadata for ${url}: ${error.message}`);
            return { thumbnail: null, title: '' };
        }
    }

    // Custom WebPageTool for direct content fetching
    class WebPageTool {
        name = 'web_page_fetch';
        description = 'Fetches and extracts content from a webpage URL';

        async _call(url) {
            try {
                const startActivity = {
                    type: 'fetch',
                    status: 'started',
                    url
                };
                webActivityEmitter.emit('activity', startActivity);
                sendToTerminal(startActivity);

                const [response, metadata] = await Promise.all([
                    axios.get(url, {
                        timeout: 10000,
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                        }
                    }),
                    getPageMetadata(url)
                ]);

                const $ = cheerio.load(response.data);
                
                // Remove non-content elements
                $('script, style, nav, header, footer, iframe').remove();
                
                // Extract text content
                const text = $('body').text()
                    .replace(/\s+/g, ' ')
                    .trim()
                    .slice(0, 8000);

                const successActivity = {
                    type: 'fetch',
                    status: 'success',
                    url,
                    title: metadata.title,
                    thumbnail: metadata.thumbnail,
                    content: text.slice(0, 300) + '...'
                };
                webActivityEmitter.emit('activity', successActivity);
                sendToTerminal(successActivity);
                
                return `Page Title: ${metadata.title}\n\n${text}`;
            } catch (error) {
                console.error(`Web page fetch failed: ${error.message}`);
                const errorActivity = {
                    type: 'fetch',
                    status: 'error',
                    url,
                    error: error.message
                };
                webActivityEmitter.emit('activity', errorActivity);
                sendToTerminal(errorActivity);
                return `Error fetching webpage: ${error.message}`;
            }
        }
    }

    // TrackedWebSearch tool using SearchClient (Serper)
    class TrackedWebSearch {
        name = 'web_search';
        description = 'Search the web for current information and news using Serper.';
        constructor(searchClient) {
            this.searchClient = searchClient;
        }
        async _call(input) {
            try {
                const searchActivity = {
                    type: 'Web Search',
                    content: `Searching for: ${input}`,
                    metadata: {
                        query: input,
                        timestamp: new Date().toISOString()
                    }
                };
                webActivityEmitter.emit('activity', searchActivity);
                sendToTerminal(searchActivity);
                const params = { q: input };
                const result = await this.searchClient.searchLocal(params);
                if (result.organic && result.organic.length > 0) {
                    const formattedResults = result.organic.slice(0, 5).map(item => {
                        const resultActivity = {
                            type: 'Search Result',
                            content: `${item.title}\n${item.snippet || ''}`,
                            metadata: {
                                url: item.link,
                                thumbnail: item.favicon,
                            }
                        };
                        webActivityEmitter.emit('activity', resultActivity);
                        sendToTerminal(resultActivity);
                        return `${item.title}\n${item.link}\n${item.snippet || ''}\n`;
                    }).join('\n');
                    return formattedResults;
                }
                const noResultsActivity = {
                    type: 'Web Search',
                    content: 'No results found.',
                    metadata: { query: input }
                };
                webActivityEmitter.emit('activity', noResultsActivity);
                sendToTerminal(noResultsActivity);
                return 'No results found.';
            } catch (error) {
                const errorActivity = {
                    type: 'Web Search',
                    content: `Web search error: ${error.message}`,
                    metadata: { query: input }
                };
                webActivityEmitter.emit('activity', errorActivity);
                sendToTerminal(errorActivity);
                return `Web search error: ${error.message}`;
            }
        }
    }

    // Wrap Wikipedia tool to track activity and include images
    class TrackedWikipedia extends WikipediaQueryRun {
        async _call(input) {
            try {
                const startActivity = {
                    type: 'wikipedia',
                    status: 'started',
                    query: input
                };
                webActivityEmitter.emit('activity', startActivity);
                sendToTerminal(startActivity);
                
                const result = await super._call(input);
                
                // Try to extract first image from Wikipedia result
                const imageMatch = result.match(/https:\/\/[^\s]+\.(?:jpg|png|gif)/i);
                
                const successActivity = {
                    type: 'wikipedia',
                    status: 'success',
                    query: input,
                    content: result.slice(0, 200) + '...',
                    thumbnail: imageMatch ? imageMatch[0] : null
                };
                webActivityEmitter.emit('activity', successActivity);
                sendToTerminal(successActivity);
                
                return result;
            } catch (error) {
                console.error(`Wikipedia query failed: ${error.message}`);
                const errorActivity = {
                    type: 'wikipedia',
                    status: 'error',
                    query: input,
                    error: error.message
                };
                webActivityEmitter.emit('activity', errorActivity);
                sendToTerminal(errorActivity);
                return `Wikipedia error: ${error.message}`;
            }
        }
    }

    // Image search tool with activity tracking
    class TrackedImageSearch {
        name = 'image_search';
        description = 'Search for images related to a query. Use this when users ask for images, photos, pictures, or visual content.';

        constructor() {
            this.searchClient = new SearchClient(process.env.RAPIDAPI_KEY, process.env.PEXELS_API_KEY);
        }

        async _call(input) {
            try {
                const startActivity = {
                    type: 'image_search',
                    status: 'started',
                    query: input
                };
                webActivityEmitter.emit('activity', startActivity);
                sendToTerminal(startActivity);

                const result = await this.searchClient.searchImages({ q: input, count: 8 });
                
                if (result.image_results && result.image_results.length > 0) {
                    // Format results for display
                    const formattedResults = result.image_results
                        .slice(0, 6)
                        .map((image, index) => {
                            const imageActivity = {
                                type: 'Image Result',
                                content: `Image ${index + 1}: ${image.title || 'Untitled'}`,
                                metadata: {
                                    url: image.link,
                                    thumbnail: image.thumbnail,
                                    title: image.title || 'Untitled Image'
                                }
                            };
                            webActivityEmitter.emit('activity', imageActivity);
                            sendToTerminal(imageActivity);
                            
                            return `Image ${index + 1}: ${image.title || 'Untitled'}\nURL: ${image.link}\nThumbnail: ${image.thumbnail}\n`;
                        })
                        .join('\n');

                    const successActivity = {
                        type: 'image_search',
                        status: 'success',
                        query: input,
                        content: `Found ${result.image_results.length} images for "${input}"`,
                        images: result.image_results
                    };
                    webActivityEmitter.emit('activity', successActivity);
                    sendToTerminal(successActivity);

                    return `Found ${result.image_results.length} images for "${input}":\n\n${formattedResults}`;
                } else {
                    const noResultsActivity = {
                        type: 'image_search',
                        status: 'no-results',
                        query: input,
                        content: `No images found for "${input}"`
                    };
                    webActivityEmitter.emit('activity', noResultsActivity);
                    sendToTerminal(noResultsActivity);

                    return `No images found for "${input}". Try using different search terms.`;
                }
            } catch (error) {
                console.error(`Image search failed: ${error.message}`);
                const errorActivity = {
                    type: 'image_search',
                    status: 'error',
                    query: input,
                    error: error.message
                };
                webActivityEmitter.emit('activity', errorActivity);
                sendToTerminal(errorActivity);
                return `Image search error: ${error.message}`;
            }
        }
    }

    // Initialize model with Claude 3 Sonnet
    const model = new ChatAnthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
        modelName: 'claude-opus-4-20250514',
        maxTokens: 2048,
        temperature: 0.7
    });

    // Set up memory for conversation history
    const memory = new BufferMemory({
        returnMessages: true,
        memoryKey: 'chat_history'
    });

    // Initialize SearchClient for Serper and RapidAPI
    const searchClient = new SearchClient(
        process.env.SERPER_API_KEY,
        process.env.RAPIDAPI_KEY,
        process.env.PEXELS_API_KEY
    );

    // Initialize tools with tracking
    const webSearch = new TrackedWebSearch(searchClient);
    const wikipedia = new TrackedWikipedia();
    const webPageTool = new WebPageTool();
    const imageSearch = new TrackedImageSearch();

    // Create tools array with all capabilities
    const tools = [webSearch, wikipedia, webPageTool, imageSearch];

    // Create prompt template with memory and tools context
    const prompt = PromptTemplate.fromTemplate(`
    You are Claude 3, a helpful and intelligent AI assistant. The current date is ${getCurrentDate()}. You have access to the following tools:
    1. Web Search (for current information and news)
    2. Wikipedia (for detailed information about topics)
    3. Web Page Fetching (for reading specific web pages)
    4. Image Search (for finding images related to a query)

    For queries about current information, resources, or anything that might need verification, always use the appropriate tools.
    When asked about "resources" or "searching", or when a specific year is mentioned, make sure to use the web search tools to find relevant information.

    For image-related queries:
    - Use the Image Search tool when users ask for images, photos, pictures, or visual content
    - Examples: "show me images of cats", "find photos of Paris", "search for pictures of mountains"
    - The tool will return image URLs and thumbnails that can be displayed

    Important date guidelines:
    - The current year is ${new Date().getFullYear()}
    - Years before ${new Date().getFullYear()} are historical and can be researched
    - Years equal to ${new Date().getFullYear()} are current
    - Years after ${new Date().getFullYear()} are future and speculative

    When presenting search results:
    1. Focus on results matching the requested year when specified
    2. Highlight papers and articles from academic sources
    3. Note publication dates and recency of information
    4. Identify authoritative sources (universities, research institutions, etc.)
    5. Include context about result freshness (e.g., recent vs. older findings)

    When presenting image results:
    1. Mention that images are available in the web panel
    2. Provide context about the images found
    3. Suggest alternative search terms if no images are found

    Previous conversation:
    {chat_history}

    User: {input}
    Assistant: Let me help you with that.
    `);

    // Create a chain that combines prompt, model, and output parsing
    const chain = RunnableSequence.from([
        {
            input: (input) => input.input,
            chat_history: async () => {
                const memoryResult = await memory.loadMemoryVariables({});
                return memoryResult.chat_history || '';
            }
        },
        prompt,
        model,
        new StringOutputParser()
    ]);

    // Initialize agent executor
    let executor;

    // Initialize the agent executor with tools
    const initializeExecutor = async () => {
        try {
            executor = await initializeAgentExecutorWithOptions(tools, model, {
                agentType: 'chat-conversational-react-description',
                verbose: process.env.NODE_ENV === 'development',
                memory,
                maxIterations: 3,
                returnIntermediateSteps: false
            });
            console.log('Chat executor initialized');
        } catch (error) {
            console.error('Failed to initialize executor:', error);
            throw error;
        }
    };

    // Helper function to format AI responses
    export function formatAIResponse(response) {
        try {
            // Check if response is already structured (has markdown headings)
            if (response.includes('##') || response.includes('#')) {
                return response;
            }

            // Try to detect sections and structure them
            const sections = [];
            let currentText = '';

            response.split('\n').forEach(line => {
                // Check for potential section headers (capitalized phrases followed by :)
                if (/^[A-Z][A-Za-z\s]+:/.test(line)) {
                    if (currentText) {
                        sections.push(currentText.trim());
                    }
                    currentText = `## ${line}`;
                } else if (/^\d+\.\s/.test(line)) {
                    // Numbered lists
                    if (!currentText.includes('## ')) {
                        if (currentText) sections.push(currentText.trim());
                        currentText = '## Key Points\n';
                    }
                    currentText += line + '\n';
                } else if (/^[•\-\*]\s/.test(line)) {
                    // Bullet points
                    if (!currentText.includes('## ')) {
                        if (currentText) sections.push(currentText.trim());
                        currentText = '## Details\n';
                    }
                    currentText += line + '\n';
                } else {
                    currentText += line + '\n';
                }
            });

            if (currentText) {
                sections.push(currentText.trim());
            }

            // If no sections were detected, wrap the whole response in a summary section
            if (sections.length === 0) {
                return `## Summary\n${response}`;
            }

            return sections.join('\n\n');
        } catch (error) {
            console.error('Error formatting AI response:', error);
            return response;
        }
    }

    // Helper function to classify queries using LLM
    async function classifyQuery(query) {
        try {
            const classificationPrompt = `Analyze this query: "${query}"

Determine if this query requires a web search based on these criteria:

1. Information Type:
- Static/General Knowledge: Basic concepts, definitions, established facts, general principles
- Dynamic/Current Information: News, recent developments, real-time data, current statistics
- Visual Content: Images, photos, pictures, visual representations

2. Information Freshness:
- Timeless: Information that doesn't change significantly over time
- Time-Sensitive: Information that needs to be current or recent

3. Information Scope:
- Universal: Information that is generally accepted and consistent across sources
- Specific: Information that might vary by source, location, or context

4. Information Verification:
- Self-contained: Can be answered with general knowledge
- External Reference: Requires looking up specific facts, sources, or current data

5. Visual Content:
- Text-only: Can be answered with text
- Visual: Requires images, photos, or visual content

Examples:
- "What is machine learning?" -> static (basic concept, timeless knowledge)
- "What are the latest developments in machine learning?" -> search (current information needed)
- "How does a neural network work?" -> static (established technical concept)
- "What are the current applications of neural networks?" -> search (current usage examples needed)
- "Show me images of cats" -> search (visual content needed)
- "Find photos of Paris" -> search (visual content needed)

Based on the above analysis, determine if this query requires a web search.
Reply with only one word - either "search" or "static".
Do not include any other text or explanation in your response.`;
            const response = await model.invoke(classificationPrompt);
            const decision = response.trim().toLowerCase();
            return decision === 'search';
        } catch (error) {
            console.error('Query classification error (Claude LLM):', error && error.response ? error.response.data : error);
            // If classification fails, DO NOT web search, just answer as chatbot
            return false;
        }
    }

    // Helper function to determine if web search is needed (fallback)
    function needsWebSearch(query) {
        // Only trigger for queries with clear current/today/latest/news keywords
        const webSearchPatterns = [
            /latest/i,
            /news/i,
            /current/i,
            /today/i,
            /breaking/i,
            /trending/i,
            /recent/i,
            /update/i,
            /live/i
        ];
        return webSearchPatterns.some(pattern => pattern.test(query));
    }

    // Main chat function that processes user input
    export async function chat(input) {
        return new Promise(async (resolve) => {
            const webActivities = [];
            
            // Listen for web activities
            const activityHandler = (activity) => {
                webActivities.push(activity);
            };
            
            webActivityEmitter.on('activity', activityHandler);
            
            try {
                if (!executor) {
                    await initializeExecutor();
                }

                console.log('\n=== Processing Query ===');
                console.log(`Query: ${input}`);

                // Classify query using LLM
                const needsWeb = await classifyQuery(input);
                
                // If query doesn't need web search, use static model
                if (!needsWeb) {
                    const staticResponse = await model.invoke(input);
                    webActivityEmitter.off('activity', activityHandler);
                    
                    resolve({
                        response: formatAIResponse(staticResponse.trim()),
                        webActivity: webActivities
                    });
                    return;
                }

                // Check for year references and validate them
                const yearMatch = input.match(/\b(20\d{2})\b/);
                const currentYear = new Date().getFullYear();
                
                if (yearMatch) {
                    const year = parseInt(yearMatch[1], 10);
                    if (year > currentYear) {
                        // Remove listener
                        webActivityEmitter.off('activity', activityHandler);
                        
                        resolve({
                            response: `I can only search for information up to the current year (${currentYear}). If you'd like, I can search for current forecasts and predictions about ${year}, or I can modify the search to look for the most recent information available.`,
                            webActivity: webActivities
                        });
                        return;
                    }
                }

                const agentResponse = await executor.invoke({ input });
                
                // Format response for better readability
                let response = agentResponse.output.trim();

                // Add line breaks between paragraphs if needed
                response = response
                    .replace(/([.!?])\s+/g, '$1\n\n') // Add breaks after sentences
                    .replace(/\n{3,}/g, '\n\n') // Remove excessive line breaks
                    .replace(/([^.!?])\n([A-Z])/g, '$1\n\n$2') // Add breaks between paragraphs
                    .trim();

                // Save the interaction to memory
                await memory.saveContext(
                    { input },
                    { output: response }
                );

                // Check if we have search results
                const hasSearchResults = webActivities.some(
                    activity => activity.type === 'Search Result'
                );

                // Check if we have image results
                const hasImageResults = webActivities.some(
                    activity => activity.type === 'Image Result'
                );

                // Add note about web panel if we have search results
                if (hasSearchResults) {
                    response += '\n\nI\'ve included the search results in the panel to the right for your reference.';
                }

                // Add note about images if we have image results
                if (hasImageResults) {
                    response += '\n\nI\'ve found some images related to your query. You can view them in the web panel to the right.';
                }

                // Format the AI response for better readability
                response = formatAIResponse(response);

                // Remove listener
                webActivityEmitter.off('activity', activityHandler);
                
                resolve({
                    response,
                    webActivity: webActivities
                });

            } catch (error) {
                console.error('Chat Error:', error);
                // Remove listener
                webActivityEmitter.off('activity', activityHandler);
                // Always provide a fallback LLM response
                resolve({
                    response: `I'm sorry, I couldn't generate a response due to a technical issue. Please try again or rephrase your question.`,
                    webActivity: webActivities,
                    error: true
                });
            }
        });
    }

    // Initialize the executor when the module is imported
    initializeExecutor().catch(error => {
        console.error('Failed to initialize executor:', error);
    });

    // Example usage:
    // const response = await chat("What's the latest news about AI?");
    // console.log(response);
