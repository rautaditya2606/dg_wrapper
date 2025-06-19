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
        const response = await axios(options);
        return response.data;
    }

    async searchImages(params) {
        if (!params.q) {
            throw new Error('Query parameter "q" is required');
        }
        const options = {
            method: 'POST',
            url: this.baseUrl,
            headers: {
                'Content-Type': 'application/json',
                'x-rapidapi-host': 'google-api31.p.rapidapi.com',
                'x-rapidapi-key': this.apiKey
            },
            data: { query: params.q, type: 'images' }
        };
        const response = await axios(options);
        return response.data;
    }
}
