import https from 'https';

interface SearchResponse {
  code: number;
  status: number;
  data: Array<{
    title: string;
    description: string;
    url: string;
    content: string;
    usage: { tokens: number; };
  }>;
}

export function search(query: string, token: string): Promise<SearchResponse> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 's.jina.ai',
      port: 443,
      path: `/${encodeURIComponent(query)}`,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-Retain-Images': 'none'
      }
    };

    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => responseData += chunk);
      res.on('end', () => resolve(JSON.parse(responseData)));
    });

    req.on('error', reject);
    req.end();
  });
}
