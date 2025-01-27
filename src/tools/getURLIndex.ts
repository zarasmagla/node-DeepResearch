interface SearchResult {
  title: string;
  url: string;
  description: string;
}

interface QueryResult {
  query: string;
  results: SearchResult[];
}

export interface StepData {
  step: number;
  question: string;
  action: string;
  reasoning: string;
  searchQuery?: string;
  result?: QueryResult[];
}

export function buildURLMap(data: StepData[]): Record<string, string> {
  const urlMap: Record<string, string> = {};

  data.forEach(step => {
    if (step.result && Array.isArray(step.result)) {
      step.result.forEach(queryResult => {
        if (queryResult.results && Array.isArray(queryResult.results)) {
          queryResult.results.forEach(result => {
            if (!urlMap[result.url]) {
              urlMap[result.url] = `${result.title}`;
            }
          });
        }
      });
    }
  });

  return urlMap;
}
