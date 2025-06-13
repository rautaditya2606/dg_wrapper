import { GoogleSearch } from 'google-search-results-nodejs';

export class SerpSearchClient {
    constructor(apiKey) {
        this.client = new GoogleSearch(apiKey);
    }

    async searchLocal(params) {
        // Ensure required parameters are present
        if (!params.q) {
            throw new Error('Query parameter "q" is required');
        }

        const searchParams = {
            ...params,
            engine: "google"
        };

        return new Promise((resolve, reject) => {
            this.client.json(searchParams, (data) => resolve(data), (error) => reject(error));
        });
    }

    async searchImages(params) {
        // Ensure required parameters are present
        if (!params.q) {
            throw new Error('Query parameter "q" is required');
        }

        const searchParams = {
            ...params,
            engine: "google",
            tbm: "isch"
        };

        return new Promise((resolve, reject) => {
            this.client.json(searchParams, (data) => resolve(data), (error) => reject(error));
        });
    }
}
