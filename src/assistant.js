    // Import required dependencies
    import { config } from 'dotenv';
    import { ChatAnthropic } from '@langchain/anthropic';
    import { SerpAPI } from '@langchain/community/tools/serpapi';
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

    // Wrap SerpAPI to track web activity and include thumbnails
    class TrackedSerpAPI extends SerpAPI {
        async _call(input) {
            try {
                // Extract year from query
                const yearMatch = input.match(/\b(20\d{2})\b/);
                const currentYear = new Date().getFullYear();
                
                // Validate year
                let year = null;
                if (yearMatch) {
                    const parsedYear = parseInt(yearMatch[1], 10);
                    if (parsedYear <= currentYear) {
                        year = parsedYear;
                    }
                }
                
                // Emit initial search activity
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
                
                // Add date filter if valid year found
                let params = input;
                if (year) {
                    params = {
                        q: input,
                        tbs: `cdr:1,cd_min:1/1/${year},cd_max:12/31/${year}`
                    };
                }
                
                const result = await super._call(params);
                const parsedResult = typeof result === 'string' ? JSON.parse(result) : result;
                
                if (parsedResult.organic_results?.length > 0) {
                    // Format results with year context
                    const formattedResults = parsedResult.organic_results
                        .slice(0, 5)
                        .map(item => {
                            // Extract date from snippet or title if possible
                            const dateMatch = (item.snippet || item.title).match(/\b(20\d{2})\b/);
                            const itemYear = dateMatch ? parseInt(dateMatch[1], 10) : null;
                            
                            // Add visual indicator for result age
                            let ageIndicator = '';
                            if (itemYear) {
                                if (itemYear === currentYear) ageIndicator = '🆕 ';
                                else if (itemYear === currentYear - 1) ageIndicator = '📅 ';
                            }
                            
                            const resultActivity = {
                                type: 'Search Result',
                                content: `${ageIndicator}${item.title}\n${item.snippet || ''}`,
                                metadata: {
                                    url: item.link,
                                    thumbnail: item.thumbnail,
                                    year: itemYear
                                }
                            };
                            webActivityEmitter.emit('activity', resultActivity);
                            sendToTerminal(resultActivity);
                            
                            return `${ageIndicator}${item.title}\n${item.link}\n${item.snippet || ''}\n`;
                        })
                        .join('\n');
                    
                    return formattedResults;
                }
                
                const noResultsActivity = {
                    type: 'Web Search',
                    content: 'No results found for this query. Try rephrasing your search terms.',
                    metadata: {
                        query: input,
                        timestamp: new Date().toISOString(),
                        status: 'no-results'
                    }
                };
                webActivityEmitter.emit('activity', noResultsActivity);
                sendToTerminal(noResultsActivity);
                
                return "No relevant search results found for your query. Try adjusting your search terms or time period.";
            } catch (error) {
                console.error(`SerpAPI search failed: ${error.message}`);
                const errorActivity = {
                    type: 'search',
                    status: 'error',
                    query: input,
                    error: error.message
                };
                webActivityEmitter.emit('activity', errorActivity);
                sendToTerminal(errorActivity);
                return `I encountered an error while searching: ${error.message}. Please try rephrasing your query.`;
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

    config();

    // Initialize model with Claude 3 Sonnet
    const model = new ChatAnthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
        modelName: 'claude-sonnet-4-20250514',
        maxTokens: 2048,
        temperature: 0.7
    });

    // Set up memory for conversation history
    // const memory = new SimpleMemory(); // This line is removed as per the edit hint

    // Initialize tools with tracking
    const tools = [];
    
    // Only add SerpAPI if API key is available
    if (process.env.SERPAPI_API_KEY && process.env.SERPAPI_API_KEY.trim()) {
    const serpapi = new TrackedSerpAPI(process.env.SERPAPI_API_KEY);
        tools.push(serpapi);
    }
    
    const wikipedia = new TrackedWikipedia();
    tools.push(wikipedia);
    
    const webPageTool = new WebPageTool();
    tools.push(webPageTool);
    
    const imageSearch = new TrackedImageSearch();
    tools.push(imageSearch);

    // Create tools array with all capabilities
    // const tools = [serpapi, wikipedia, webPageTool, imageSearch]; // This line is removed as per the edit hint

    // Create prompt template with tools context
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

    User: {input}
    Assistant: Let me help you with that.
    `);

    // Create a chain that combines prompt, model, and output parsing
    const chain = RunnableSequence.from([
        prompt,
        model,
        new StringOutputParser()
    ]);

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
            console.error('Query classification error:', error);
            // Fallback to pattern matching if LLM classification fails
            return needsWebSearch(query);
        }
    }

    // Helper function to determine if web search is needed (fallback)
    function needsWebSearch(query) {
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

        const imagePatterns = [
            /image/i,
            /photo/i,
            /picture/i,
            /show\s+me/i,
            /visual/i,
            /look\s+like/i,
            /appearance/i
        ];

        return informationPatterns.some(pattern => pattern.test(query)) || 
               imagePatterns.some(pattern => pattern.test(query));
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

                const agentResponse = await chain.invoke({ input });
                
                // Format response for better readability
                let response = agentResponse.trim();

                // Add line breaks between paragraphs if needed
                response = response
                    .replace(/([.!?])\s+/g, '$1\n\n') // Add breaks after sentences
                    .replace(/\n{3,}/g, '\n\n') // Remove excessive line breaks
                    .replace(/([^.!?])\n([A-Z])/g, '$1\n\n$2') // Add breaks between paragraphs
                    .trim();

                // Save the interaction to memory
                // await memory.saveContext( // This line is removed as per the edit hint
                //     { input },
                //     { output: response }
                // );

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
                
                resolve({
                    response: `I apologize, but I encountered an error while processing your request: ${error.message}`,
                    webActivity: webActivities,
                    error: true
                });
            }
        });
    }

    // Example usage:
    // const response = await chat("What's the latest news about AI?");
    // console.log(response);
