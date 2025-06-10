// Import required dependencies
import { config } from 'dotenv';
import { ChatAnthropic } from '@langchain/anthropic';
import { SerpAPI } from 'langchain/tools';  // Keep using langchain/tools until full community migration
import { BufferMemory } from 'langchain/memory';  // Keep using langchain/memory
import { AgentExecutor, initializeAgentExecutorWithOptions } from 'langchain/agents';  // Keep using langchain/agents
import { PromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { StringOutputParser } from '@langchain/core/output_parsers';

config();

// Initialize model with Claude 3 Sonnet
const model = new ChatAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  modelName: 'claude-3-sonnet-20240229',  // Using Claude 3 Sonnet
  maxTokens: 2048,
  temperature: 0.7
});

// Set up memory for conversation history
const memory = new BufferMemory({
  returnMessages: true,
  memoryKey: 'chat_history'
});

// Initialize SerpAPI tool for web searches
const serpapi = new SerpAPI(process.env.SERPAPI_API_KEY);

// Create tools array
const tools = [serpapi];

// Create prompt template with memory and tools context
const prompt = PromptTemplate.fromTemplate(`
You are a helpful and intelligent assistant. Use memory and web search to respond with accurate, context-aware answers.

Chat History:
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
  executor = await initializeAgentExecutorWithOptions(tools, model, {
    agentType: 'chat-conversational-react-description',
    verbose: true,
    memory,
    maxIterations: 3,
    returnIntermediateSteps: false
  });
};

// Main chat function that processes user input
export async function chat(input) {
  try {
    // Log the query that is being processed
    console.log('\n=== Processing Query ===');
    console.log(`Query: ${input}`);
    console.log('=====================\n');

    if (!executor) {
      await initializeExecutor();
    }

    // First try direct chain for simple queries
    try {
      const chainResponse = await model.invoke(input);
      // If chain response seems complete, return it
      if (chainResponse && !chainResponse.includes("I need to search") && !chainResponse.includes("Let me look that up")) {
        console.log('=== Direct Chain Response ===');
        return chainResponse;
      }
    } catch (chainError) {
      console.error('Chain Error:', chainError);
      // Continue to agent if chain fails
    }

    // Fall back to agent for complex queries
    try {
      const agentResponse = await executor.invoke({ input });
      console.log('=== Agent Response ===');
      return agentResponse.output;
    } catch (agentError) {
      console.error('Agent Error:', agentError);
      throw new Error('Failed to process query through both chain and agent');
    }
  } catch (error) {
    console.error('=== Chat Error ===');
    console.error(error.stack || error);
    throw error;
  }
}

// Initialize the executor
await initializeExecutor();

// Example usage:
// const response = await chat("What's the latest news about AI?");
// console.log(response);
