import axios from 'axios';

export class RapidAPISearchClient {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseUrl = 'https://google-api31.p.rapidapi.com/websearch';
    }

    async searchLocal(params) {
        if (!params.q) {
            throw new Error('Query parameter "q" is required');
        }
        
        console.log('Searching web for:', params.q);
        
        const options = {
            method: 'POST',
            url: this.baseUrl,
            headers: {
                'Content-Type': 'application/json',
                'x-rapidapi-host': 'google-api31.p.rapidapi.com',
                'x-rapidapi-key': this.apiKey
            },
            data: {
                text: params.q,
                safesearch: 'off',
                timelimit: '',
                region: 'wt-wt',
                max_results: 20
            }
        };
        
        try {
            const response = await axios(options);
            console.log('Web search response:', response.data);
            return response.data;
        } catch (error) {
            console.error('Web search error:', error.response?.data || error.message);
            throw error;
        }
    }

    async searchImages(params) {
        if (!params.q) {
            throw new Error('Query parameter "q" is required');
        }
        
        console.log('Searching images for:', params.q);
        
        // Since the /images endpoint doesn't exist, we'll modify the web search
        // to include "images" in the query and try to extract image URLs
        const imageQuery = `${params.q} images`;
        
        const options = {
            method: 'POST',
            url: this.baseUrl,
            headers: {
                'Content-Type': 'application/json',
                'x-rapidapi-host': 'google-api31.p.rapidapi.com',
                'x-rapidapi-key': this.apiKey
            },
            data: {
                text: imageQuery,
                safesearch: 'off',
                timelimit: '',
                region: 'wt-wt',
                max_results: 20
            }
        };
        
        try {
            const response = await axios(options);
            console.log('Image search response:', response.data);
            
            // Try to extract image URLs from the web results
            // This is a fallback approach since we can't use a dedicated image search
            const results = response.data.result || [];
            const imageResults = results
                .filter(result => {
                    // Look for results that might contain images
                    const title = result.title?.toLowerCase() || '';
                    const body = result.body?.toLowerCase() || '';
                    return title.includes('image') || title.includes('photo') || title.includes('picture') ||
                           body.includes('image') || body.includes('photo') || body.includes('picture') ||
                           result.href?.includes('images') || result.href?.includes('photos');
                })
                .map(result => ({
                    title: result.title,
                    link: result.href,
                    thumbnail: null, // We can't get actual thumbnails from web search
                    image: null,
                    src: null
                }));
            
            return {
                image_results: imageResults,
                result: imageResults
            };
        } catch (error) {
            console.error('Image search error:', error.response?.data || error.message);
            throw error;
        }
    }
}
