import axios from 'axios';

export class SearchClient {
    constructor(rapidApiKey, pexelsApiKey) {
        this.rapidApiKey = rapidApiKey;
        this.pexelsApiKey = pexelsApiKey;
        this.rapidApiBaseUrl = 'https://google-api31.p.rapidapi.com/websearch';
        this.googleImagesApiUrl = 'https://google-images4.p.rapidapi.com/getGoogleImages';
    }

    async searchLocal(params) {
        if (!params.q) {
            throw new Error('Query parameter "q" is required');
        }
        console.log('Searching web for:', params.q);
        const options = {
            method: 'POST',
            url: this.rapidApiBaseUrl,
            headers: {
                'Content-Type': 'application/json',
                'x-rapidapi-host': 'google-api31.p.rapidapi.com',
                'x-rapidapi-key': this.rapidApiKey
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
        console.log('Searching images (Google Images) for:', params.q);
        const options = {
            method: 'GET',
            url: this.googleImagesApiUrl,
            headers: {
                'x-rapidapi-host': 'google-images4.p.rapidapi.com',
                'x-rapidapi-key': this.rapidApiKey
            },
            params: {
                query: params.q,
                count: params.count || 10
            }
        };
        try {
            const response = await axios(options);
            console.log('Google Images search response:', response.data);
            
            // Handle different response formats
            let images = [];
            if (response.data.images && Array.isArray(response.data.images)) {
                // Format: { images: ["url1", "url2", ...] }
                images = response.data.images;
            } else if (Array.isArray(response.data)) {
                // Format: ["url1", "url2", ...]
                images = response.data;
            } else if (response.data.result && Array.isArray(response.data.result)) {
                // Format: { result: ["url1", "url2", ...] }
                images = response.data.result;
            }
            
            // Convert simple URLs to the expected object format
            const imageResults = images.map((image, index) => {
                // If image is already an object with properties, use it as is
                if (typeof image === 'object' && image !== null) {
                    return {
                        title: image.title || `Image ${index + 1}`,
                        link: image.link || image.url || '',
                        thumbnail: image.thumbnail || image.link || image.url || '',
                        image: image.link || image.url || '',
                        src: {
                            original: image.link || image.url || '',
                            medium: image.thumbnail || image.link || image.url || '',
                            small: image.thumbnail || image.link || image.url || ''
                        }
                    };
                }
                
                // If image is a string URL, create object structure
                const imageUrl = String(image);
                return {
                    title: `Image ${index + 1}`,
                    link: imageUrl,
                    thumbnail: imageUrl,
                    image: imageUrl,
                    src: {
                        original: imageUrl,
                        medium: imageUrl,
                        small: imageUrl
                    }
                };
            });
            
            return {
                image_results: imageResults,
                result: imageResults
            };
        } catch (error) {
            console.error('Google Images search error:', error.response?.data || error.message);
            throw error;
        }
    }
}
