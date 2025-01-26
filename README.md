```bash
export GOOGLE_API_KEY=...  # ask han
export JINA_API_KEY=jina_...  # get from jina.ai
npm install
# example: no tool calling 
npm run dev "1+1="
npm run dev "what is the capital of France?"

# example: simple
npm run dev "what is the latest news from Jina AI?"

# example: wrong answer
npm run dev "what is the twitter account of jina ai's founder"

# example: open question, long chain of thoughts
npm run dev "who will be president of US in 2028?"
npm run dev "what should be jina ai strategy for 2025?"
```
