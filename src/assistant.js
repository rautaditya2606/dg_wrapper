// Import required dependencies
import { config } from 'dotenv';
import { ChatAnthropic } from '@langchain/anthropic';
import { SerpAPI } from 'langchain/tools';
import { BufferMemory } from 'langchain/memory';
import { AgentExecutor, initializeAgentExecutorWithOptions } from 'langchain/agents';
import { PromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { WikipediaQueryRun } from '@langchain/community/tools/wikipedia_query_run';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { EventEmitter } from 'events';

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
            webActivityEmitter.emit('activity', {
                type: 'fetch',
                status: 'started',
                url
            });

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

            webActivityEmitter.emit('activity', {
                type: 'fetch',
                status: 'success',
                url,
                title: metadata.title,
                thumbnail: metadata.thumbnail,
                content: text.slice(0, 300) + '...'
            });
            
            return `Page Title: ${metadata.title}\n\n${text}`;
        } catch (error) {
            console.error(`Web page fetch failed: ${error.message}`);
            webActivityEmitter.emit('activity', {
                type: 'fetch',
                status: 'error',
                url,
                error: error.message
            });
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
            webActivityEmitter.emit('activity', {
                type: 'Web Search',
                content: `Searching for: ${input}`,
                metadata: {
                    query: input,
                    timestamp: new Date().toISOString()
                }
            });
            
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
                        
                        webActivityEmitter.emit('activity', {
                            type: 'Search Result',
                            content: `${ageIndicator}${item.title}\n${item.snippet || ''}`,
                            metadata: {
                                url: item.link,
                                thumbnail: item.thumbnail,
                                year: itemYear
                            }
                        });
                        
                        return `${ageIndicator}${item.title}\n${item.link}\n${item.snippet || ''}\n`;
                    })
                    .join('\n');
                
                return formattedResults;
            }
            
            webActivityEmitter.emit('activity', {
                type: 'Web Search',
                content: 'No results found for this query. Try rephrasing your search terms.',
                metadata: {
                    query: input,
                    timestamp: new Date().toISOString(),
                    status: 'no-results'
                }
            });
            
            return "No relevant search results found for your query. Try adjusting your search terms or time period.";
        } catch (error) {
            console.error(`SerpAPI search failed: ${error.message}`);
            webActivityEmitter.emit('activity', {
                type: 'search',
                status: 'error',
                query: input,
                error: error.message
            });
            return `I encountered an error while searching: ${error.message}. Please try rephrasing your query.`;
        }
    }
}

// Wrap Wikipedia tool to track activity and include images
class TrackedWikipedia extends WikipediaQueryRun {
    async _call(input) {
        try {
            webActivityEmitter.emit('activity', {
                type: 'wikipedia',
                status: 'started',
                query: input
            });
            
            const result = await super._call(input);
            
            // Try to extract first image from Wikipedia result
            const imageMatch = result.match(/https:\/\/[^\s]+\.(?:jpg|png|gif)/i);
            
            webActivityEmitter.emit('activity', {
                type: 'wikipedia',
                status: 'success',
                query: input,
                content: result.slice(0, 200) + '...',
                thumbnail: imageMatch ? imageMatch[0] : null
            });
            
            return result;
        } catch (error) {
            console.error(`Wikipedia query failed: ${error.message}`);
            webActivityEmitter.emit('activity', {
                type: 'wikipedia',
                status: 'error',
                query: input,
                error: error.message
            });
            return `Wikipedia error: ${error.message}`;
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
const memory = new BufferMemory({
    returnMessages: true,
    memoryKey: 'chat_history'
});

// Initialize tools with tracking
const serpapi = new TrackedSerpAPI(process.env.SERPAPI_API_KEY);
const wikipedia = new TrackedWikipedia();
const webPageTool = new WebPageTool();

// Create tools array with all capabilities
const tools = [serpapi, wikipedia, webPageTool];

// Create prompt template with memory and tools context
const prompt = PromptTemplate.fromTemplate(`
You are Claude 3, a helpful and intelligent AI assistant. The current date is ${getCurrentDate()}. You have access to the following tools:
1. Web Search (for current information and news)
2. Wikipedia (for detailed information about topics)
3. Web Page Fetching (for reading specific web pages)

For queries about current information, resources, or anything that might need verification, always use the appropriate tools.
When asked about "resources" or "searching", or when a specific year is mentioned, make sure to use the web search tools to find relevant information.

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

            // Add note about web panel if we have search results
            if (hasSearchResults) {
                response += '\n\nI\'ve included the search results in the panel to the right for your reference.';
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

// Initialize the executor when the module is imported
initializeExecutor().catch(error => {
    console.error('Failed to initialize executor:', error);
});

// Example usage:
// const response = await chat("What's the latest news about AI?");
// console.log(response);
