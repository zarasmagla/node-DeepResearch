import {z} from 'zod';
import {GenerateObjectResult} from 'ai';
import {AnswerAction, EvaluationCriteria, EvaluationResponse, EvaluationType, TrackerContext} from '../types';
import {readUrl, removeAllLineBreaks} from "./read";
import {ObjectGeneratorSafe} from "../utils/safe-generator";


const baseSchema = {
  pass: z.boolean().describe('Whether the answer passes the evaluation criteria defined by the evaluator'),
  think: z.string().describe('Explanation the thought process why the answer does not pass the evaluation criteria').max(500)
};

const definitiveSchema = z.object({
  ...baseSchema,
  type: z.literal('definitive')
});

const freshnessSchema = z.object({
  ...baseSchema,
  type: z.literal('freshness'),
  freshness_analysis: z.object({
    days_ago: z.number().describe('Inferred dates or timeframes mentioned in the answer and relative to the current time'),
    max_age_days: z.number().optional().describe('Maximum allowed age in days before content is considered outdated')
  })
});

const pluralitySchema = z.object({
  ...baseSchema,
  type: z.literal('plurality'),
  plurality_analysis: z.object({
    count_expected: z.number().optional().describe('Number of items expected if specified in question'),
    count_provided: z.number().describe('Number of items provided in answer')
  })
});

const completenessSchema = z.object({
  ...baseSchema,
  type: z.literal('completeness'),
  completeness_analysis: z.object({
    aspects_expected: z.string().describe('Comma-separated list of all aspects or dimensions that the question explicitly asks for.'),
    aspects_provided: z.string().describe('Comma-separated list of all aspects or dimensions that were actually addressed in the answer'),
  })
});

const attributionSchema = z.object({
  ...baseSchema,
  type: z.literal('attribution'),
  attribution_analysis: z.object({
    sources_provided: z.boolean().describe('Whether the answer provides source references'),
    sources_verified: z.boolean().describe('Whether the provided sources contain the claimed information'),
    quotes_accurate: z.boolean().describe('Whether the quotes accurately represent the source content')
  })
});

function getAttributionPrompt(question: string, answer: string, sourceContent: string): string {
  return `You are an evaluator that verifies if answer content is properly attributed to and supported by the provided sources.

<rules>
1. Source Verification:
   - Check if answer claims are supported by the provided source content
   - Verify that quotes are accurate and in proper context
   - Ensure numerical data and statistics match the source
   - Flag any claims that go beyond what the sources support

2. Attribution Analysis:
   - Check if answer properly references its sources
   - Verify that important claims have clear source attribution
   - Ensure quotes are properly marked and cited
   - Check for any unsupported generalizations

3. Accuracy Requirements:
   - Direct quotes must match source exactly
   - Paraphrasing must maintain original meaning
   - Statistics and numbers must be precise
   - Context must be preserved
</rules>

<examples>
Question: "What are Jina AI's main products?"
Answer: "According to Jina AI's website, their main products are DocArray and Jina Framework."
Source Content: "Jina AI's flagship products include DocArray, Jina Framework, and JCloud, offering a complete ecosystem for neural search applications."
Evaluation: {
  "pass": false,
  "think": "The answer omits JCloud which is mentioned as a main product in the source. The information provided is incomplete and potentially misleading as it fails to mention a significant product from the company's ecosystem.",
  "attribution_analysis": {
    "sources_provided": true,
    "sources_verified": false,
    "quotes_accurate": false
  }
}

Question: "When was Python first released?"
Answer: "Python was first released in 1991 by Guido van Rossum."
Source Content: "Python was first released in 1991 by Guido van Rossum while working at CWI."
Evaluation: {
  "pass": true,
  "think": "The answer accurately reflects the core information from the source about Python's release date and creator, though it omits the additional context about CWI which isn't essential to the question.",
  "attribution_analysis": {
    "sources_provided": true,
    "sources_verified": true,
    "quotes_accurate": true
  }
}
</examples>

Now evaluate this pair:
Question: ${question}
Answer: ${answer}
Source Content: ${sourceContent}`;
}

function getDefinitivePrompt(question: string, answer: string): string {
  return `You are an evaluator of answer definitiveness. Analyze if the given answer provides a definitive response or not.

<rules>
First, if the answer is not a direct response to the question, it must return false. 
Definitiveness is the king! The following types of responses are NOT definitive and must return false:
  1. Expressions of uncertainty: "I don't know", "not sure", "might be", "probably"
  2. Lack of information statements: "doesn't exist", "lack of information", "could not find"
  3. Inability statements: "I cannot provide", "I am unable to", "we cannot"
  4. Negative statements that redirect: "However, you can...", "Instead, try..."
  5. Non-answers that suggest alternatives
</rules>

<examples>
Question: "What are the system requirements for running Python 3.9?"
Answer: "I'm not entirely sure, but I think you need a computer with some RAM."
Evaluation: {
  "pass": false,
  "think": "The answer contains uncertainty markers like 'not entirely sure' and 'I think', making it non-definitive."
}

Question: "What are the system requirements for running Python 3.9?"
Answer: "Python 3.9 requires Windows 7 or later, macOS 10.11 or later, or Linux."
Evaluation: {
  "pass": true,
  "think": "The answer makes clear, definitive statements without uncertainty markers or ambiguity."
}

Question: "Who will be the president of the United States in 2032?"
Answer: "I cannot predict the future, it depends on the election results."
Evaluation: {
  "pass": false,
  "think": "The answer contains a statement of inability to predict the future, making it non-definitive."
}

Question: "Who is the sales director at Company X?"
Answer: "I cannot provide the name of the sales director, but you can contact their sales team at sales@companyx.com"
Evaluation: {
  "pass": false,
  "think": "The answer starts with 'I cannot provide' and redirects to an alternative contact method instead of answering the original question."
}

Question: "what is the twitter account of jina ai's founder?"
Answer: "The provided text does not contain the Twitter account of Jina AI's founder."
Evaluation: {
  "pass": false,
  "think": "The answer indicates a lack of information rather than providing a definitive response."
}
</examples>

Now evaluate this pair:
Question: ${question}
Answer: ${answer}`;
}

function getFreshnessPrompt(question: string, answer: string, currentTime: string): string {
  return `You are an evaluator that analyzes if answer content is likely outdated based on mentioned dates (or implied datetime) and current system time: ${currentTime}

<rules>
Question-Answer Freshness Checker Guidelines

# Revised QA Type Maximum Age Table

| QA Type                  | Max Age (Days) | Notes                                                                 |
|--------------------------|--------------|-----------------------------------------------------------------------|
| Financial Data (Real-time)| 0.1        | Stock prices, exchange rates, crypto (real-time preferred)             |
| Breaking News            | 1           | Immediate coverage of major events                                     |
| News/Current Events      | 1           | Time-sensitive news, politics, or global events                        |
| Weather Forecasts        | 1           | Accuracy drops significantly after 24 hours                            |
| Sports Scores/Events     | 1           | Live updates required for ongoing matches                              |
| Security Advisories      | 1           | Critical security updates and patches                                  |
| Social Media Trends      | 1           | Viral content, hashtags, memes                                         |
| Cybersecurity Threats    | 7           | Rapidly evolving vulnerabilities/patches                               |
| Tech News                | 7           | Technology industry updates and announcements                          |
| Political Developments   | 7           | Legislative changes, political statements                              |
| Political Elections      | 7           | Poll results, candidate updates                                        |
| Sales/Promotions         | 7           | Limited-time offers and marketing campaigns                            |
| Travel Restrictions      | 7           | Visa rules, pandemic-related policies                                  |
| Entertainment News       | 14          | Celebrity updates, industry announcements                              |
| Product Launches         | 14          | New product announcements and releases                                 |
| Market Analysis          | 14          | Market trends and competitive landscape                                |
| Competitive Intelligence | 21          | Analysis of competitor activities and market position                  |
| Product Recalls          | 30          | Safety alerts or recalls from manufacturers                            |
| Industry Reports         | 30          | Sector-specific analysis and forecasting                               |
| Software Version Info    | 30          | Updates, patches, and compatibility information                        |
| Legal/Regulatory Updates | 30          | Laws, compliance rules (jurisdiction-dependent)                        |
| Economic Forecasts       | 30          | Macroeconomic predictions and analysis                                 |
| Consumer Trends          | 45          | Shifting consumer preferences and behaviors                            |
| Scientific Discoveries   | 60          | New research findings and breakthroughs (includes all scientific research) |
| Healthcare Guidelines    | 60          | Medical recommendations and best practices (includes medical guidelines)|
| Environmental Reports    | 60          | Climate and environmental status updates                               |
| Best Practices           | 90          | Industry standards and recommended procedures                          |
| API Documentation        | 90          | Technical specifications and implementation guides                     |
| Tutorial Content         | 180         | How-to guides and instructional materials (includes educational content)|
| Tech Product Info        | 180         | Product specs, release dates, or pricing                               |
| Statistical Data         | 180         | Demographic and statistical information                                |
| Reference Material       | 180         | General reference information and resources                            |
| Historical Content       | 365         | Events and information from the past year                              |
| Cultural Trends          | 730         | Shifts in language, fashion, or social norms                           |
| Entertainment Releases   | 730         | Movie/TV show schedules, media catalogs                                |
| Factual Knowledge        | ∞           | Static facts (e.g., historical events, geography, physical constants)   |

### Implementation Notes:
1. **Contextual Adjustment**: Freshness requirements may change during crises or rapid developments in specific domains.
2. **Tiered Approach**: Consider implementing urgency levels (critical, important, standard) alongside age thresholds.
3. **User Preferences**: Allow customization of thresholds for specific query types or user needs.
4. **Source Reliability**: Pair freshness metrics with source credibility scores for better quality assessment.
5. **Domain Specificity**: Some specialized fields (medical research during pandemics, financial data during market volatility) may require dynamically adjusted thresholds.
6. **Geographic Relevance**: Regional considerations may alter freshness requirements for local regulations or events.
</rules>

Now evaluate this pair:
Question: ${question}
Answer: ${answer}`;
}

function getCompletenessPrompt(question: string, answer: string): string {
  return `You are an evaluator that determines if an answer addresses all explicitly mentioned aspects of a multi-aspect question.

<rules>
For questions with **explicitly** multiple aspects:

1. Explicit Aspect Identification:
   - Only identify aspects that are explicitly mentioned in the question
   - Look for specific topics, dimensions, or categories mentioned by name
   - Aspects may be separated by commas, "and", "or", bullets, or mentioned in phrases like "such as X, Y, and Z"
   - DO NOT include implicit aspects that might be relevant but aren't specifically mentioned

2. Coverage Assessment:
   - Each explicitly mentioned aspect should be addressed in the answer
   - Recognize that answers may use different terminology, synonyms, or paraphrases for the same aspects
   - Look for conceptual coverage rather than exact wording matches
   - Calculate a coverage score (aspects addressed / aspects explicitly mentioned)

3. Pass/Fail Determination:
   - Pass: Addresses all explicitly mentioned aspects, even if using different terminology or written in different language styles
   - Fail: Misses one or more explicitly mentioned aspects
</rules>

<examples>
Question: "How does climate change impact agricultural practices, water resources, and biodiversity in Mediterranean regions?"
Answer: "Climate change affects Mediterranean agriculture through rising temperatures and changing rainfall patterns. Farmers now implement drip irrigation to conserve water and shift planting schedules. Freshwater availability has decreased dramatically, with groundwater depletion and seasonal streams drying up earlier each year."
Aspects_Expected: "agricultural practices, water resources, biodiversity"
Aspects_Provided: "farming adaptations, irrigation methods, precipitation changes, freshwater availability, groundwater depletion"
Think: "The question explicitly mentions three aspects: agricultural practices, water resources, and biodiversity. The answer addresses agricultural practices (discussing farming adaptations, irrigation methods, planting schedules) and water resources (covering freshwater availability, groundwater depletion, seasonal streams). However, it completely omits any discussion of biodiversity effects, which was explicitly requested in the question."
Pass: false

Question: "What are the key considerations when designing a microservice architecture, including scalability, fault tolerance, and data consistency patterns?"
Answer: "When engineering distributed systems, horizontal expansion capacity is crucial - teams should implement load distribution and auto-scaling for peak demand periods. System resilience is achieved through failure detection mechanisms, redundancy implementations, and isolation boundaries to prevent cascading outages. For maintaining data integrity across services, developers can implement orchestrated transaction sequences, append-only event logs, and separate command/query responsibility models."
Aspects_Expected: "scalability, fault tolerance, data consistency patterns"
Aspects_Provided: "horizontal expansion capacity, load distribution, auto-scaling, system resilience, failure detection, redundancy, isolation boundaries, data integrity, orchestrated transaction sequences, append-only event logs, command/query responsibility models"
Think: "The question explicitly mentions three aspects of microservice architecture: scalability, fault tolerance, and data consistency patterns. Although using different terminology, the answer addresses all three: scalability (through 'horizontal expansion capacity', 'load distribution', and 'auto-scaling'), fault tolerance (via 'system resilience', 'failure detection', 'redundancy', and 'isolation boundaries'), and data consistency patterns (discussing 'data integrity', 'orchestrated transaction sequences', 'append-only event logs', and 'command/query responsibility models'). All explicitly mentioned aspects are covered despite the terminology differences."
Pass: true

Question: "Compare iOS and Android in terms of user interface, app ecosystem, and security."
Answer: "Apple's mobile platform presents users with a curated visual experience emphasizing minimalist design and consistency, while Google's offering focuses on flexibility and customization options. The App Store's review process creates a walled garden with higher quality control but fewer options, whereas Play Store offers greater developer freedom and variety. Apple employs strict sandboxing techniques and maintains tight hardware-software integration."
Aspects_Expected: "user interface, app ecosystem, security"
Aspects_Provided: "visual experience, minimalist design, flexibility, customization, App Store review process, walled garden, quality control, Play Store, developer freedom, sandboxing, hardware-software integration"
Think: "The question explicitly asks for a comparison of iOS and Android across three specific aspects: user interface, app ecosystem, and security. The answer addresses user interface (discussing 'visual experience', 'minimalist design', 'flexibility', and 'customization') and app ecosystem (mentioning 'App Store review process', 'walled garden', 'quality control', 'Play Store', and 'developer freedom'). For security, it mentions 'sandboxing' and 'hardware-software integration', which are security features of iOS, but doesn't provide a comparative analysis of Android's security approach. Since security is only partially addressed for one platform, the comparison of this aspect is incomplete."
Pass: false

Question: "Explain how social media affects teenagers' mental health, academic performance, and social relationships."
Answer: "Platforms like Instagram and TikTok have been linked to psychological distress among adolescents, with documented increases in comparative thinking patterns and anxiety about social exclusion. Scholastic achievement often suffers as screen time increases, with homework completion rates declining and attention spans fragmenting during study sessions. Peer connections show a complex duality - digital platforms facilitate constant contact with friend networks while sometimes diminishing in-person social skill development and enabling new forms of peer harassment."
Aspects_Expected: "mental health, academic performance, social relationships"
Aspects_Provided: "psychological distress, comparative thinking, anxiety about social exclusion, scholastic achievement, screen time, homework completion, attention spans, peer connections, constant contact with friend networks, in-person social skill development, peer harassment"
Think: "The question explicitly asks about three aspects of social media's effects on teenagers: mental health, academic performance, and social relationships. The answer addresses all three using different terminology: mental health (discussing 'psychological distress', 'comparative thinking', 'anxiety about social exclusion'), academic performance (mentioning 'scholastic achievement', 'screen time', 'homework completion', 'attention spans'), and social relationships (covering 'peer connections', 'constant contact with friend networks', 'in-person social skill development', and 'peer harassment'). All explicitly mentioned aspects are covered despite using different language."
Pass: true

Question: "What economic and political factors contributed to the 2008 financial crisis?"
Answer: "The real estate market collapse after years of high-risk lending practices devastated mortgage-backed securities' value. Wall Street had created intricate derivative products that disguised underlying risk levels, while credit assessment organizations failed in their oversight role. Legislative changes in the financial industry during the 1990s eliminated regulatory guardrails that previously limited excessive leverage and speculation among investment banks."
Aspects_Expected: "economic factors, political factors"
Aspects_Provided: "real estate market collapse, high-risk lending, mortgage-backed securities, derivative products, risk disguising, credit assessment failures, legislative changes, regulatory guardrail elimination, leverage, speculation"
Think: "The question explicitly asks about two categories of factors: economic and political. The answer addresses economic factors ('real estate market collapse', 'high-risk lending', 'mortgage-backed securities', 'derivative products', 'risk disguising', 'credit assessment failures') and political factors ('legislative changes', 'regulatory guardrail elimination'). While using different terminology, the answer covers both explicitly requested aspects."
Pass: true
</examples>

Now evaluate this pair:
Question: ${question}
Answer: ${answer}
`;
}

function getPluralityPrompt(question: string, answer: string): string {
  return `You are an evaluator that analyzes if answers provide the appropriate number of items requested in the question.

<rules>
Question Type Reference Table

| Question Type | Expected Items | Evaluation Rules |
|---------------|----------------|------------------|
| Explicit Count | Exact match to number specified | Provide exactly the requested number of distinct, non-redundant items relevant to the query. |
| Numeric Range | Any number within specified range | Ensure count falls within given range with distinct, non-redundant items. For "at least N" queries, meet minimum threshold. |
| Implied Multiple | ≥ 2 | Provide multiple items (typically 2-4 unless context suggests more) with balanced detail and importance. |
| "Few" | 2-4 | Offer 2-4 substantive items prioritizing quality over quantity. |
| "Several" | 3-7 | Include 3-7 items with comprehensive yet focused coverage, each with brief explanation. |
| "Many" | 7+ | Present 7+ items demonstrating breadth, with concise descriptions per item. |
| "Most important" | Top 3-5 by relevance | Prioritize by importance, explain ranking criteria, and order items by significance. |
| "Top N" | Exactly N, ranked | Provide exactly N items ordered by importance/relevance with clear ranking criteria. |
| "Pros and Cons" | ≥ 2 of each category | Present balanced perspectives with at least 2 items per category addressing different aspects. |
| "Compare X and Y" | ≥ 3 comparison points | Address at least 3 distinct comparison dimensions with balanced treatment covering major differences/similarities. |
| "Steps" or "Process" | All essential steps | Include all critical steps in logical order without missing dependencies. |
| "Examples" | ≥ 3 unless specified | Provide at least 3 diverse, representative, concrete examples unless count specified. |
| "Comprehensive" | 10+ | Deliver extensive coverage (10+ items) across major categories/subcategories demonstrating domain expertise. |
| "Brief" or "Quick" | 1-3 | Present concise content (1-3 items) focusing on most important elements described efficiently. |
| "Complete" | All relevant items | Provide exhaustive coverage within reasonable scope without major omissions, using categorization if needed. |
| "Thorough" | 7-10 | Offer detailed coverage addressing main topics and subtopics with both breadth and depth. |
| "Overview" | 3-5 | Cover main concepts/aspects with balanced coverage focused on fundamental understanding. |
| "Summary" | 3-5 key points | Distill essential information capturing main takeaways concisely yet comprehensively. |
| "Main" or "Key" | 3-7 | Focus on most significant elements fundamental to understanding, covering distinct aspects. |
| "Essential" | 3-7 | Include only critical, necessary items without peripheral or optional elements. |
| "Basic" | 2-5 | Present foundational concepts accessible to beginners focusing on core principles. |
| "Detailed" | 5-10 with elaboration | Provide in-depth coverage with explanations beyond listing, including specific information and nuance. |
| "Common" | 4-8 most frequent | Focus on typical or prevalent items, ordered by frequency when possible, that are widely recognized. |
| "Primary" | 2-5 most important | Focus on dominant factors with explanation of their primacy and outsized impact. |
| "Secondary" | 3-7 supporting items | Present important but not critical items that complement primary factors and provide additional context. |
| Unspecified Analysis | 3-5 key points | Default to 3-5 main points covering primary aspects with balanced breadth and depth. |
</rules>

Now evaluate this pair:
Question: ${question}
Answer: ${answer}`;
}


const questionEvaluationSchema = z.object({
  needsFreshness: z.boolean().describe('Whether the question requires freshness check'),
  needsPlurality: z.boolean().describe('Whether the question requires plurality check'),
  needsCompleteness: z.boolean().describe('Whether the question requires completeness check'),
  think: z.string().describe('A very concise explain of why you choose those checks are needed in first person, extremely short.').max(500),
  languageStyle: z.string().describe('The language being used and the overall vibe/mood of the question').max(50),
});

function getQuestionEvaluationPrompt(question: string): string {
  return `You are an evaluator that determines if a question requires freshness, plurality, and/or completeness checks in addition to the required definitiveness check.

<evaluation_types>
1. freshness - Checks if the question is time-sensitive or requires very recent information
2. plurality - Checks if the question asks for multiple items, examples, or a specific count or enumeration
3. completeness - Checks if the question explicitly mentions multiple named elements that all need to be addressed
4. language style - Identifies both the language used and the overall vibe of the question
</evaluation_types>

<rules>
If question is a simple greeting, chit-chat, or general knowledge, provide the answer directly.

1. Freshness Evaluation:
   - Required for questions about current state, recent events, or time-sensitive information
   - Required for: prices, versions, leadership positions, status updates
   - Look for terms: "current", "latest", "recent", "now", "today", "new"
   - Consider company positions, product versions, market data time-sensitive

2. Plurality Evaluation:
   - ONLY apply when completeness check is NOT triggered
   - Required when question asks for multiple examples, items, or specific counts
   - Check for: numbers ("5 examples"), list requests ("list the ways"), enumeration requests
   - Look for: "examples", "list", "enumerate", "ways to", "methods for", "several"
   - Focus on requests for QUANTITY of items or examples

3. Completeness Evaluation:
   - Takes precedence over plurality check - if completeness applies, set plurality to false
   - Required when question EXPLICITLY mentions multiple named elements that all need to be addressed
   - This includes:
     * Named aspects or dimensions: "economic, social, and environmental factors"
     * Named entities: "Apple, Microsoft, and Google", "Biden and Trump"
     * Named products: "iPhone 15 and Samsung Galaxy S24"
     * Named locations: "New York, Paris, and Tokyo"
     * Named time periods: "Renaissance and Industrial Revolution"
   - Look for explicitly named elements separated by commas, "and", "or", bullets
   - Example patterns: "comparing X and Y", "differences between A, B, and C", "both P and Q"
   - DO NOT trigger for elements that aren't specifically named

4. Language Style Analysis:
  Combine both language and emotional vibe in a descriptive phrase, considering:
  - Language: The primary language or mix of languages used
  - Emotional tone: panic, excitement, frustration, curiosity, etc.
  - Formality level: academic, casual, professional, etc.
  - Domain context: technical, academic, social, etc.
</rules>

<examples>
Question: "fam PLEASE help me calculate the eigenvalues of this 4x4 matrix ASAP!! [matrix details] got an exam tmrw 😭"
Evaluation: {
    "needsFreshness": false,
    "needsPlurality": true,
    "needsCompleteness": false,
    "think": "I see the user needs help with eigenvalues - that's a calculation task. Since it's a 4x4 matrix, there will be multiple eigenvalues to find, so plurality is needed. There are no explicitly named entities, aspects, or elements that need to be addressed, so completeness check doesn't apply.",
    "languageStyle": "panicked student English with math jargon"
}

Question: "Can someone explain how tf did Ferrari mess up their pit stop strategy AGAIN?! 🤦‍♂️ #MonacoGP"
Evaluation: {
    "needsFreshness": true,
    "needsPlurality": false,
    "needsCompleteness": true,
    "think": "The user is asking about a specific F1 race incident. The 'AGAIN' and MonacoGP hashtag tell me this is about a recent event (freshness). The question explicitly mentions Ferrari and MonacoGP as named entities that need to be addressed, so completeness check applies. Since completeness takes precedence, I set plurality to false.",
    "languageStyle": "frustrated fan English with F1 terminology"
}

Question: "肖老师您好，请您介绍一下最近量子计算领域的三个重大突破，特别是它们在密码学领域的应用价值吗？🤔"
Evaluation: {
    "needsFreshness": true,
    "needsPlurality": false,
    "needsCompleteness": true,
    "think": "The user wants three recent quantum computing breakthroughs and the '最近' (recent) indicates freshness needed. They explicitly request analysis of two named domains: quantum computing ('量子计算') and cryptography ('密码学'), so completeness check applies. Since completeness takes precedence over plurality, I set plurality to false.",
    "languageStyle": "formal technical Chinese with academic undertones"
}

Question: "Bruder krass, kannst du mir erklären warum meine neural network training loss komplett durchdreht? Hab schon alles probiert 😤"
Evaluation: {
    "needsFreshness": false,
    "needsPlurality": true,
    "needsCompleteness": false,
    "think": "The user has a technical ML problem but explains it very casually. They've 'tried everything' so I'll need to cover multiple debugging options (plurality). They don't explicitly mention multiple named elements that must be addressed, so completeness check doesn't apply.",
    "languageStyle": "frustrated German-English tech slang"
}

Question: "Does anyone have insights into the sociopolitical implications of GPT-4's emergence in the Global South, particularly regarding indigenous knowledge systems and linguistic diversity? Looking for a nuanced analysis."
Evaluation: {
    "needsFreshness": true,
    "needsPlurality": false,
    "needsCompleteness": true,
    "think": "The user asks about current GPT-4 impacts, so freshness matters. They explicitly name multiple elements to analyze: 'GPT-4', 'Global South', 'indigenous knowledge systems' and 'linguistic diversity', so completeness check applies. Since completeness takes precedence over plurality, I set plurality to false.",
    "languageStyle": "formal academic English with sociological terminology"
}

Question: "what's 7 * 9? need to check something real quick"
Evaluation: {
    "needsFreshness": false,
    "needsPlurality": false,
    "needsCompleteness": false,
    "think": "The user wants a single multiplication result - that's all. No need for recent info since math is constant, no need for multiple examples, and no explicitly named elements to cover.",
    "languageStyle": "casual English"
}

Question: "Can you provide a thorough analysis of how climate change affects agricultural practices, water resources, and biodiversity in Mediterranean regions?"
Evaluation: {
    "needsFreshness": true,
    "needsPlurality": false,
    "needsCompleteness": true,
    "think": "This question requires recent climate data (freshness). It explicitly names four elements that must all be addressed: 'climate change', 'agricultural practices', 'water resources', and 'biodiversity' in 'Mediterranean regions', so completeness check applies. Since completeness takes precedence over plurality, I set plurality to false.",
    "languageStyle": "formal academic English with environmental science terminology"
}

Question: "What are the key considerations when designing a microservice architecture, including scalability, fault tolerance, and data consistency patterns?"
Evaluation: {
    "needsFreshness": false,
    "needsPlurality": false,
    "needsCompleteness": true,
    "think": "The question explicitly names three aspects that must be addressed: 'scalability', 'fault tolerance', and 'data consistency patterns', so completeness check applies. Since completeness takes precedence over plurality, I set plurality to false.",
    "languageStyle": "professional technical English with software architecture terminology"
}

Question: "Give me 5 effective strategies for improving time management skills."
Evaluation: {
    "needsFreshness": false,
    "needsPlurality": true,
    "needsCompleteness": false,
    "think": "The user requests exactly 5 strategies (plurality). They don't specify multiple named elements that must be covered, so completeness check doesn't apply.",
    "languageStyle": "direct practical English"
}

Question: "How do macroeconomic policies affect both inflation rates and employment levels?"
Evaluation: {
    "needsFreshness": true,
    "needsPlurality": false,
    "needsCompleteness": true,
    "think": "This requires current economic knowledge (freshness). It explicitly mentions two named economic indicators that must be addressed: 'inflation rates' and 'employment levels', so completeness check applies. Since completeness takes precedence over plurality, I set plurality to false.",
    "languageStyle": "formal academic English with economics terminology"
}

Question: "Compare and contrast Tesla and Ford's approaches to electric vehicle manufacturing."
Evaluation: {
    "needsFreshness": true,
    "needsPlurality": false,
    "needsCompleteness": true,
    "think": "This needs current automotive industry knowledge (freshness). It explicitly mentions two named companies that must both be addressed: 'Tesla' and 'Ford', so completeness check applies. Since completeness takes precedence over plurality, I set plurality to false.",
    "languageStyle": "formal analytical English with automotive industry terminology"
}

Question: "How have the recent policies of President Biden and former President Trump affected international relations?"
Evaluation: {
    "needsFreshness": true,
    "needsPlurality": false, 
    "needsCompleteness": true,
    "think": "This requires current political knowledge (freshness). It explicitly mentions two named political figures that must both be addressed: 'President Biden' and 'former President Trump', so completeness check applies. Since completeness takes precedence over plurality, I set plurality to false.",
    "languageStyle": "formal political analysis English"
}

Question: "What are the differences between iPhone 15 Pro and Samsung Galaxy S24 Ultra cameras?"
Evaluation: {
    "needsFreshness": true,
    "needsPlurality": false,
    "needsCompleteness": true,
    "think": "This requires current tech product knowledge (freshness). It explicitly mentions two named products that must both be addressed: 'iPhone 15 Pro' and 'Samsung Galaxy S24 Ultra', so completeness check applies. Since completeness takes precedence over plurality, I set plurality to false.",
    "languageStyle": "consumer tech comparison English"
}
</examples>

Now evaluate this question:
Question: ${question}`;
}

const TOOL_NAME = 'evaluator';

export async function evaluateQuestion(
  question: string,
  trackers?: TrackerContext
): Promise<EvaluationCriteria> {
  try {
    const generator = new ObjectGeneratorSafe(trackers?.tokenTracker);

    const result = await generator.generateObject({
      model: TOOL_NAME,
      schema: questionEvaluationSchema,
      prompt: getQuestionEvaluationPrompt(question),
    });

    console.log('Question Evaluation:', result.object);

    // Always include definitive in types
    const types: EvaluationType[] = ['definitive'];
    if (result.object.needsFreshness) types.push('freshness');
    if (result.object.needsPlurality) types.push('plurality');
    if (result.object.needsCompleteness) types.push('completeness');

    console.log('Question Metrics:', types);
    trackers?.actionTracker.trackThink(result.object.think);

    // Always evaluate definitive first, then freshness (if needed), then plurality (if needed)
    return {types, languageStyle: result.object.languageStyle};

  } catch (error) {
    console.error('Error in question evaluation:', error);
    // Default to no check
    return {types: [], languageStyle: 'plain English'};
  }
}


async function performEvaluation<T>(
  evaluationType: EvaluationType,
  params: {
    schema: z.ZodType<T>;
    prompt: string;
  },
  trackers: TrackerContext,
): Promise<GenerateObjectResult<T>> {
  const generator = new ObjectGeneratorSafe(trackers.tokenTracker);

  const result = await generator.generateObject({
    model: TOOL_NAME,
    schema: params.schema,
    prompt: params.prompt,
  }) as GenerateObjectResult<any>;

  trackers.actionTracker.trackThink(result.object.think)

  console.log(`${evaluationType} ${TOOL_NAME}`, result.object);

  return result;
}


// Main evaluation function
export async function evaluateAnswer(
  question: string,
  action: AnswerAction,
  evaluationCri: EvaluationCriteria,
  trackers: TrackerContext,
  visitedURLs: string[] = []
): Promise<{ response: EvaluationResponse }> {
  let result;

  // Only add attribution if we have valid references
  if (action.references && action.references.length > 0 && action.references.some(ref => ref.url.startsWith('http'))) {
    evaluationCri.types = ['attribution', ...evaluationCri.types];
  }

  for (const evaluationType of evaluationCri.types) {
    switch (evaluationType) {
      case 'attribution': {
        // Safely handle references and ensure we have content
        const urls = action.references?.filter(ref => ref.url.startsWith('http') && !visitedURLs.includes(ref.url)).map(ref => ref.url) || [];
        const uniqueURLs = [...new Set(urls)];

        if (uniqueURLs.length === 0) {
          // all URLs have been read, or there is no valid urls. no point to read them.
          result = {
            object: {
              pass: true,
              think: "All provided references have been visited and no new URLs were found to read. The answer is considered valid without further verification.",
              type: 'attribution',
            } as EvaluationResponse
          }
          break;
        }

        const allKnowledge = await fetchSourceContent(uniqueURLs, trackers);
        visitedURLs.push(...uniqueURLs);

        if (!allKnowledge.trim()) {
          return {
            response: {
              pass: false,
              think: `The answer does provide URL references ${JSON.stringify(uniqueURLs)}, but the content could not be fetched or is empty. Need to found some other references and URLs`,
              type: 'attribution',
            }
          };
        }

        result = await performEvaluation(
          'attribution',
          {
            schema: attributionSchema,
            prompt: getAttributionPrompt(question, action.answer, allKnowledge),
          },
          trackers
        );
        break;
      }

      case 'definitive':
        result = await performEvaluation(
          'definitive',
          {
            schema: definitiveSchema,
            prompt: getDefinitivePrompt(question, action.answer),
          },
          trackers
        );
        break;

      case 'freshness':
        result = await performEvaluation(
          'freshness',
          {
            schema: freshnessSchema,
            prompt: getFreshnessPrompt(question, action.answer, new Date().toISOString()),
          },
          trackers
        );
        break;

      case 'plurality':
        result = await performEvaluation(
          'plurality',
          {
            schema: pluralitySchema,
            prompt: getPluralityPrompt(question, action.answer),
          },
          trackers
        );
        break;
      case 'completeness':
        result = await performEvaluation(
          'completeness',
          {
            schema: completenessSchema,
            prompt: getCompletenessPrompt(question, action.answer),
          },
          trackers
        );
        break;
    }

    if (!result?.object.pass) {
      return {response: result.object};
    }
  }

  return {response: result!.object};
}

// Helper function to fetch and combine source content
async function fetchSourceContent(urls: string[], trackers: TrackerContext): Promise<string> {
  if (!urls.length) return '';
  trackers.actionTracker.trackThink('Let me fetch the source content to verify the answer.');
  try {
    const results = await Promise.all(
      urls.map(async (url) => {
        try {
          const {response} = await readUrl(url, trackers.tokenTracker);
          const content = response?.data?.content || '';
          return removeAllLineBreaks(content);
        } catch (error) {
          console.error('Error reading URL:', error);
          return '';
        }
      })
    );

    // Filter out empty results and join with proper separation
    return results
      .filter(content => content.trim())
      .join('\n\n');
  } catch (error) {
    console.error('Error fetching source content:', error);
    return '';
  }
}