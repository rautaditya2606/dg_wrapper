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
                max_results: 20,
                type: 'images'
            }
        };
        
        try {
            const response = await axios(options);
            console.log('Image search response:', response.data);
            return response.data;
        } catch (error) {
            console.error('Image search error:', error.response?.data || error.message);
            throw error;
        }
    }
}
