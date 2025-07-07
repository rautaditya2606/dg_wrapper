import axios from 'axios';

export class SearchClient {
    constructor(serperApiKey, rapidApiKey, pexelsApiKey) {
        this.serperApiKey = serperApiKey;
        this.rapidApiKey = rapidApiKey;
        this.pexelsApiKey = pexelsApiKey;
        this.webApiBaseUrl = 'https://google.serper.dev/search';
        this.googleImagesApiUrl = 'https://google-images4.p.rapidapi.com/getGoogleImages';
    }

    async searchLocal(params) {
        if (!params.q) {
            throw new Error('Query parameter "q" is required');
        }
        console.log('Searching web for:', params.q);
        console.log('Using Serper API key:', this.serperApiKey ? `${this.serperApiKey.substring(0, 10)}...` : 'NOT SET');
        
        const options = {
            method: 'POST',
            url: this.webApiBaseUrl,
            headers: {
                'Content-Type': 'application/json',
                'X-API-KEY': this.serperApiKey
            },
            data: {
                q: params.q
            }
        };
        
        console.log('Web search request options:', {
            url: options.url,
            method: options.method,
            headers: options.headers,
            data: options.data
        });
        
        try {
            const response = await axios(options);
            console.log('Web search response status:', response.status);
            console.log('Web search response data:', response.data);
            return response.data;
        } catch (error) {
            console.error('Web search error details:', {
                message: error.message,
                status: error.response?.status,
                statusText: error.response?.statusText,
                data: error.response?.data,
                headers: error.response?.headers
            });
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
