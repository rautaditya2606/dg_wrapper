// Test scenarios for the AI assistant
import { chat } from './assistant.js';

async function runTests() {
  try {
    console.log('\n=== Starting Test Scenarios ===\n');

    // Test 1: Basic knowledge query
    console.log('📝 User Query:', '"What is machine learning?"');
    console.log('----------------------------------------');
    let response = await chat("What is machine learning?");
    console.log('🤖 AI Response:\n', response, '\n');

    // Allow time for memory persistence
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Test 2: Context awareness
    console.log('📝 User Query:', '"What are some popular algorithms used in it?"');
    console.log('----------------------------------------');
    response = await chat("What are some popular algorithms used in it?");
    console.log('🤖 AI Response:\n', response, '\n');

    await new Promise(resolve => setTimeout(resolve, 1000));

    // Test 3: Real-time search capability
    console.log('📝 User Query:', '"What are the latest developments in quantum computing?"');
    console.log('----------------------------------------');
    response = await chat("What are the latest developments in quantum computing?");
    console.log('🤖 AI Response:\n', response, '\n');

    console.log('=== All Tests Completed ===\n');
  } catch (error) {
    console.error('Test Error:', error);
    process.exit(1);
  }
}

runTests();
