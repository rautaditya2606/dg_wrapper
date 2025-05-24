require('dotenv').config();
const express = require('express');
const path = require('path');
const SerpApi = require('google-search-results-nodejs');
const { OpenAI } = require('openai');

const app = express();
const openai = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY
});
const search = new SerpApi.GoogleSearch(process.env.SERPAPI_API_KEY);

app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get('/', (req, res) => {
	res.render('index', { result: null });
});

// Add retry utility function
const withRetry = async (fn, retries = 3, delay = 1000) => {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (i === retries - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
};

app.post('/search', async (req, res) => {
	try {
		const query = req.body.query;
		// Add script to remove loading state
		const removeLoadingScript = `
			<script>
				document.body.classList.remove('loading');
			</script>
		`;
		const stages = {
			serpapi: 'Fetching search results and images...',
			openai: 'Analyzing search results...',
			processing: 'Processing and formatting response...'
		};

		// Add timeout protection
		const timeout = setTimeout(() => {
			throw new Error('Request timed out');
		}, 30000); // 30 second timeout

		try {
			// Get search results with retry
			const [searchResults, textResults] = await Promise.all([
				withRetry(() => new Promise((resolve, reject) => {
					search.json({
						q: query,
						engine: 'google',
						tbm: 'isch', // Include image results
						num: 10 // Number of results
					}, (result) => resolve(result), (error) => reject(error));
				})),
				withRetry(() => new Promise((resolve, reject) => {
					search.json({
						q: query,
						engine: 'google'
					}, (result) => resolve(result), (error) => reject(error));
				}))
			]).catch(error => {
				console.error('SerpAPI Error:', error);
				throw new Error('Failed to fetch search results. Please try again.');
			});

			// Analyze with OpenAI
			const gptResponse = await openai.chat.completions.create({
				model: 'gpt-3.5-turbo',
				messages: [{
					role: 'user',
					content: `Analyze these search results for "${query}" and provide a comprehensive analysis in this exact JSON format:

{
    "summary": "2-3 sentence overview",
    "keyPoints": [
        "point 1",
        "point 2",
        "point 3"
    ],
    "analysis": {
        "contentQuality": "assessment of content quality",
        "credibility": "evaluation of source credibility",
        "relevance": "relevance to query",
        "insights": "notable findings"
    },
    "context": {
        "background": "historical or background info",
        "relatedTopics": ["topic 1", "topic 2"],
        "misconceptions": ["misconception 1", "misconception 2"]
    },
    "recommendations": {
        "research": ["research area 1", "research area 2"],
        "applications": ["application 1", "application 2"]
    }
}

Search Results to Analyze:
${JSON.stringify(textResults.organic_results?.slice(0, 3), null, 2)}

Ensure the response is valid JSON that exactly matches this structure.`
				}],
				max_tokens: 1000,
				temperature: 0.7
			});

			clearTimeout(timeout);
			// Parse the JSON response
			const analysisData = JSON.parse(gptResponse.choices[0].message.content);
			
			res.render('index', {
				result: {
					query,
					analysis: analysisData,
					searchResults: textResults.organic_results?.slice(0, 3) || [],
					images: searchResults.images_results?.slice(0, 4) || [],
					stages: Object.values(stages) // Include processing stages in response
				}
			});
		} finally {
			clearTimeout(timeout);
		}
	} catch (error) {
		console.error('Error:', error);
		res.render('index', {
			result: {
				error: `Error: ${error.message}. Please try again later.`,
				searchResults: [], // Add empty array for error case
				images: []  // Add empty array for error case
			}
		});
	}
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
	console.log(`Server started on http://localhost:${PORT}`);
});