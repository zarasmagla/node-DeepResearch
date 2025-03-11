import axios from 'axios';
import { SERPER_API_KEY } from "../config";

import { SerperSearchResponse } from '../types';

export async function serperSearch(query: string): Promise<{ response: SerperSearchResponse }> {
    const response = await axios.post<SerperSearchResponse>('https://google.serper.dev/search', {
        q: query,
        autocorrect: false,
    }, {
        headers: {
            'X-API-KEY': SERPER_API_KEY,
            'Content-Type': 'application/json'
        },
        timeout: 10000
    });

    if (response.status !== 200) {
        throw new Error(`Serper search failed: ${response.status} ${response.statusText}`)
    }

    // Maintain the same return structure as the original code
    return { response: response.data };
}
