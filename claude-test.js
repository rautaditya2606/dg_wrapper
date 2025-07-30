import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function testClaude() {
  try {
    console.log('Testing Claude API...');
    console.log('API Key format check:', process.env.ANTHROPIC_API_KEY?.startsWith('sk-ant-'));
    console.log('API Key length:', process.env.ANTHROPIC_API_KEY?.length);
    
    const response = await anthropic.messages.create({
      model: "claude-3-opus-20240229",
      max_tokens: 100,
      temperature: 0.7,
      messages: [{ role: "user", content: "Hello, how are you?" }]
    });
    
    console.log('✅ Claude response received:');
    console.log('Response:', response);
    console.log('Text:', response.content[0]?.text);
    
  } catch (error) {
    console.error('❌ Claude direct test error:');
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    console.error('Error response data:', error?.response?.data);
    console.error('Full error object:', error);
  }
}

testClaude(); 