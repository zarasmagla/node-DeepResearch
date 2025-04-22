addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

// Add this helper function at the top level
// Improved parseDate function to handle more date formats
function parseDate(dateStr) {
  if (!dateStr) return null;

  // Clean up the string (remove extra spaces, normalize separators)
  let cleanStr = dateStr.trim()
    .replace(/\s+/g, ' ')
    .replace(/-(\d{2}:)/, ' $1'); // Fix formats like 2025-03-05-21:25:00

  // Try direct parsing first
  const date = new Date(cleanStr);
  if (!isNaN(date.getTime())) return date;

  // Try parsing ISO-like formats with variations
  const isoPattern = /(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})(?:[T\s-](\d{1,2})[:\.](\d{1,2})(?:[:\.](\d{1,2}))?)?/;
  const isoMatch = cleanStr.match(isoPattern);
  if (isoMatch) {
    const year = parseInt(isoMatch[1]);
    const month = parseInt(isoMatch[2]) - 1; // JS months are 0-indexed
    const day = parseInt(isoMatch[3]);
    const hour = isoMatch[4] ? parseInt(isoMatch[4]) : 0;
    const minute = isoMatch[5] ? parseInt(isoMatch[5]) : 0;
    const second = isoMatch[6] ? parseInt(isoMatch[6]) : 0;

    const newDate = new Date(year, month, day, hour, minute, second);
    if (!isNaN(newDate.getTime())) return newDate;
  }

  // Try MM/DD/YYYY and DD/MM/YYYY formats
  const slashPattern = /(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/;
  const slashMatch = cleanStr.match(slashPattern);
  if (slashMatch) {
    // Try both MM/DD/YYYY and DD/MM/YYYY interpretations
    const parts = [parseInt(slashMatch[1]), parseInt(slashMatch[2]), parseInt(slashMatch[3])];

    // MM/DD/YYYY attempt
    const usDate = new Date(parts[2], parts[0] - 1, parts[1]);
    if (!isNaN(usDate.getTime()) && usDate.getMonth() === parts[0] - 1 && usDate.getDate() === parts[1]) {
      return usDate;
    }

    // DD/MM/YYYY attempt
    const euDate = new Date(parts[2], parts[1] - 1, parts[0]);
    if (!isNaN(euDate.getTime()) && euDate.getMonth() === parts[1] - 1 && euDate.getDate() === parts[0]) {
      return euDate;
    }
  }

  // Try month name patterns
  const monthNamePattern = /([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i;
  const monthMatch = cleanStr.match(monthNamePattern);
  if (monthMatch) {
    const newDate = new Date(`${monthMatch[1]} ${monthMatch[2]}, ${monthMatch[3]}`);
    if (!isNaN(newDate.getTime())) return newDate;
  }

  // Try Unix timestamps (seconds or milliseconds)
  if (/^\d+$/.test(cleanStr)) {
    const timestamp = parseInt(cleanStr);
    // If the number is too small to be a millisecond timestamp but could be seconds
    const date = new Date(timestamp > 9999999999 ? timestamp : timestamp * 1000);
    if (!isNaN(date.getTime()) && date.getFullYear() > 1970 && date.getFullYear() < 2100) {
      return date;
    }
  }

  return null;
}

// Add this function to detect schema.org timestamps
function extractSchemaOrgTimestamps(html) {
  const results = [];

  // Find JSON+LD scripts with Schema.org data
  const schemaPattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let schemaMatch;

  while ((schemaMatch = schemaPattern.exec(html)) !== null) {
    try {
      const jsonData = JSON.parse(schemaMatch[1]);

      // Process array of schemas or single schema object
      const schemas = Array.isArray(jsonData) ? jsonData : [jsonData];

      for (const schema of schemas) {
        // Handle nested graphs
        if (schema['@graph'] && Array.isArray(schema['@graph'])) {
          for (const item of schema['@graph']) {
            extractDatesFromSchema(item, results);
          }
        } else {
          extractDatesFromSchema(schema, results);
        }
      }
    } catch (e) {
      // Skip invalid JSON
    }
  }

  return results;
}

// Helper function to extract dates from schema objects
function extractDatesFromSchema(schema, results) {
  const dateProperties = [
    'dateModified',
    'dateUpdated',
    'datePublished',
    'dateCreated',
    'uploadDate',
    'lastReviewed'
  ];

  for (const prop of dateProperties) {
    if (schema[prop]) {
      const date = parseDate(schema[prop]);
      if (date) {
        results.push({
          type: 'schemaOrg',
          field: prop,
          date: date.toISOString(),
          priority: prop === 'dateModified' ? 'high' :
                   prop === 'dateUpdated' ? 'high' : 'medium',
          context: `Schema.org ${schema['@type'] || 'object'}`
        });
      }
    }
  }

  // Check for nested objects that might contain dates
  if (schema.mainEntity) {
    extractDatesFromSchema(schema.mainEntity, results);
  }

  // Handle Article specific schema
  if (schema['@type'] === 'Article' && schema.author) {
    const authorObj = typeof schema.author === 'object' ? schema.author : {};
    for (const prop of dateProperties) {
      if (authorObj[prop]) {
        const date = parseDate(authorObj[prop]);
        if (date) {
          results.push({
            type: 'schemaOrg',
            field: `author.${prop}`,
            date: date.toISOString(),
            priority: 'medium',
            context: 'Article author'
          });
        }
      }
    }
  }
}

// Add this function to extract HTML comments that might contain version info
function extractHtmlComments(html) {
  const results = [];
  const commentPattern = /<!--([\s\S]*?)-->/g;
  let commentMatch;

  while ((commentMatch = commentPattern.exec(html)) !== null) {
    const comment = commentMatch[1];

    // Look for version patterns
    const versionPattern = /(?:version|v|revision|rev|updated|modified|timestamp)[\s:=]+([0-9.]+|\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})/i;
    const versionMatch = comment.match(versionPattern);

    if (versionMatch) {
      // Try to parse as date
      const date = parseDate(versionMatch[1]);
      if (date) {
        results.push({
          type: 'htmlComment',
          date: date.toISOString(),
          context: comment.trim().substring(0, 100),
          version: versionMatch[1]
        });
      } else if (/\d{4}-\d{2}-\d{2}/.test(versionMatch[1])) {
        // Looks like a date but couldn't parse, try manual parsing
        const parts = versionMatch[1].split(/[-\/]/);
        if (parts.length === 3 && parts[0].length === 4) {
          const date = new Date(`${parts[0]}-${parts[1]}-${parts[2]}`);
          if (!isNaN(date.getTime())) {
            results.push({
              type: 'htmlComment',
              date: date.toISOString(),
              context: comment.trim().substring(0, 100)
            });
          }
        }
      }
    }

    // Look for date patterns
    const datePattern = /(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4}|\d{1,2} [A-Za-z]+ \d{4})/;
    const dateMatch = comment.match(datePattern);

    if (dateMatch && !versionMatch) {
      const date = parseDate(dateMatch[1]);
      if (date) {
        results.push({
          type: 'htmlComment',
          date: date.toISOString(),
          context: comment.trim().substring(0, 100)
        });
      }
    }
  }

  return results;
}

// Add this function to check Git blame info (sometimes exposed in HTML comments)
function extractGitInfo(html) {
  const results = {};

  // Look for Git hash in comments
  const gitHashPattern = /<!--[\s\S]*?(?:commit|hash|git)[:\s]+([a-f0-9]{7,40})[\s\S]*?-->/i;
  const gitHashMatch = html.match(gitHashPattern);

  if (gitHashMatch) {
    results.gitHash = gitHashMatch[1];

    // Look for date near the hash
    const nearbyDatePattern = new RegExp(`<!--[\\s\\S]*?${gitHashMatch[1]}[\\s\\S]*?(\\d{4}-\\d{2}-\\d{2}|\\d{2}/\\d{2}/\\d{4})[\\s\\S]*?-->`, 'i');
    const nearbyDateMatch = html.match(nearbyDatePattern);

    if (nearbyDateMatch) {
      const date = parseDate(nearbyDateMatch[1]);
      if (date) {
        results.gitDate = date.toISOString();
      }
    }
  }

  // Look for GitLab/GitHub deploy comments
  const deployPattern = /<!--[\s\S]*?(?:deployed|deployment|deploy)[\s\S]*?((?:\d{4}-\d{2}-\d{2})|(?:\d{2}\/\d{2}\/\d{4}))[\\s\\S]*?-->/i;
  const deployMatch = html.match(deployPattern);

  if (deployMatch) {
    const date = parseDate(deployMatch[1]);
    if (date) {
      results.deployDate = date.toISOString();
    }
  }

  return results;
}

// Add cache support with HTTP Cache-Control directives
async function handleRequest(request) {
  // Parse the URL from the request
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('url');

  if (!targetUrl) {
    return new Response('Please provide a URL parameter', { status: 400 });
  }

  // Check client cache control preferences
  const cacheControl = request.headers.get('Cache-Control') || '';
  const noCache = cacheControl.includes('no-cache') || cacheControl.includes('max-age=0');

  // Generate a cache key - must be a valid URL for Cloudflare's Cache API
  // Use the current URL with a custom header to create a valid URL cache key
  const cacheKeyUrl = new URL(request.url);
  cacheKeyUrl.searchParams.set('__cache_target', targetUrl);
  const cacheKey = new Request(cacheKeyUrl.toString(), {
    headers: new Headers({ 'x-cache-key': 'true' })
  });

  // Try to get from cache if not explicitly disabled
  if (!noCache) {
    // Use Cloudflare cache if available
    const cachedResponse = await caches.default.match(cacheKey);
    if (cachedResponse) {
      // Add cache indicator header
      return new Response(cachedResponse.body, {
        headers: {
          ...Object.fromEntries(cachedResponse.headers.entries()),
          'X-Cache': 'HIT',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
  }

  try {
    // Fetch the target webpage with all headers preserved
    const response = await fetch(targetUrl, {
      cf: {
        // Bypass cache to get fresh content if no-cache requested
        cacheTtl: noCache ? 0 : 300,
        cacheEverything: !noCache
      }
    });

    const text = await response.text();

    // Extract all possible time indicators with our improved detectors
    const updateTimes = await extractAllTimeIndicators(response, text, targetUrl);

    // Advanced heuristic-based determination of the "true" update time
    const bestGuess = determineBestUpdateTime(updateTimes);

    // Content fingerprinting for change detection
    const contentFingerprint = await generateContentFingerprint(text);

    // Result with confidence score
    const result = {
      url: targetUrl,
      methods: updateTimes,
      bestGuess: bestGuess.timestamp,
      confidence: bestGuess.confidence,
      reasoning: bestGuess.reasoning,
      contentFingerprint: contentFingerprint,
      processedAt: new Date().toISOString()
    };

    const resultJson = JSON.stringify(result, null, 2);
    const resultResponse = new Response(resultJson, {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300',
        'X-Cache': 'MISS'
      }
    });

    // Store in cache for future requests (if not explicitly disabled)
    if (!noCache) {
      await caches.default.put(cacheKey, resultResponse.clone());
    }

    return resultResponse;
  } catch (error) {
    return new Response(JSON.stringify({
      error: error.message,
      url: targetUrl
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}

// Modify the extractAllTimeIndicators function to include these new sources
async function extractAllTimeIndicators(response, html, targetUrl) {
  const result = {
    // Standard HTTP headers
    lastModified: response.headers.get('last-modified') || null,
    etag: response.headers.get('etag') || null,
    date: response.headers.get('date') || null,
    expires: response.headers.get('expires') || null,

    // HTML metadata
    metaTags: extractMetaUpdateTimes(html),

    // HTML content-based timestamps
    visibleDates: extractVisibleDates(html),

    // URL parameters that might indicate versioning
    urlVersioning: extractUrlVersionIndicators(targetUrl),

    // JavaScript timestamps
    jsTimestamps: extractJavaScriptTimestamps(html),

    // Add Schema.org timestamps extraction
    schemaOrgTimestamps: extractSchemaOrgTimestamps(html),

    // Add HTML comments extraction
    htmlComments: extractHtmlComments(html),

    // Add Git info extraction
    gitInfo: extractGitInfo(html),

    // CSS and resource timestamps
    resourceTimestamps: extractResourceTimestamps(html),

    // CMS-specific indicators
    cmsSpecificTimestamps: extractCMSSpecificTimestamps(html),

    // Footer copyright years
    copyrightYears: extractCopyrightYears(html),

    // Comparative indicators
    serverTime: response.headers.get('date') || null,

    // DOM structural fingerprint (helps detect if layout changed)
    domFingerprint: generateDOMFingerprint(html)
  };

  // If no time indicators found, try to fetch the sitemap for this page
  if (!hasValidTimestamp(result)) {
    result.sitemapLastmod = await extractSitemapLastmod(targetUrl);
  }

  return result;
}

function extractMetaUpdateTimes(html) {
  const results = {};

  // More flexible meta tag pattern matching (attribute order independent)
  const metaTimePattern = /<meta\s+(?:[^>]*?\s+)?(?:name|property)=["']([^"']+)["'](?:[^>]*?\s+)?content=["']([^"']+)["']|<meta\s+(?:[^>]*?\s+)?content=["']([^"']+)["'](?:[^>]*?\s+)?(?:name|property)=["']([^"']+)["']/gi;

  let match;
  while ((match = metaTimePattern.exec(html)) !== null) {
    // Handle both attribute orders
    const name = match[1] || match[4];
    const content = match[2] || match[3];

    if (!name || !content) continue;

    // Check for various time-related meta tags
    if (/last[-_]?modified|modified[-_]?time|update[-_]?time|date[-_]?modified|modified|revision/i.test(name)) {
      const date = parseDate(content);
      if (date) {
        results.lastModified = date.toISOString();
      }
    }
    else if (/published[-_]?time|pub[-_]?date|date[-_]?published|creation[-_]?date|firstpublishedtime/i.test(name)) {
      const date = parseDate(content);
      if (date) {
        results.publishedDate = date.toISOString();
      }
    }
    else if (/article:modified_time|og:updated_time/i.test(name)) {
      const date = parseDate(content);
      if (date) {
        results.articleModified = date.toISOString();
      }
    }
    else if (/article:published_time|og:published_time/i.test(name)) {
      const date = parseDate(content);
      if (date) {
        results.articlePublished = date.toISOString();
      }
    }
    else if (/page[-_]?generated[-_]?time|gendate|generated|others/i.test(name) && /\d{4}[-\/]\d{1,2}[-\/]\d{1,2}/.test(content)) {
      // Extract date from content that might contain other text
      const dateMatch = content.match(/(\d{4}[-\/]\d{1,2}[-\/]\d{1,2}(?:\s+\d{1,2}:\d{1,2}(?::\d{1,2})?)?)/);
      if (dateMatch) {
        const date = parseDate(dateMatch[1]);
        if (date) {
          results.pageGenerated = date.toISOString();
        }
      }
    }
  }

  return results;
}

// Add this helper to provide better visible date extraction
function extractVisibleDates(html) {
  const results = [];

  // Common date indicator classes
  const dateClassPattern = /<(?:div|span|p)\s+class=["'](?:[^"']*\s+)?(?:date|time|timestamp|pubdate|updated|modified|posted-on|entry-date|publish-date|post-date)[^"']*["'][^>]*>([^<]+)/gi;

  let match;
  while ((match = dateClassPattern.exec(html)) !== null) {
    const content = match[1].trim();
    // Check if content looks date-like
    if (/\d{4}/.test(content)) {
      const date = parseDate(content);
      if (date) {
        results.push({
          type: 'dateClass',
          date: date.toISOString(),
          context: content,
          priority: 'medium'
        });
      }
    }
  }

  // Extract dates from time elements (more reliable)
  const timePattern = /<time(?:\s+[^>]*)?\s+datetime=["']([^"']+)["'][^>]*>.*?<\/time>/gi;
  while ((match = timePattern.exec(html)) !== null) {
    const datetime = match[1];
    const date = parseDate(datetime);
    if (date) {
      results.push({
        type: 'timeElement',
        date: date.toISOString(),
        context: match[0].substring(0, 100),
        priority: 'high' // Time elements are usually more reliable
      });
    }
  }

  // Common date patterns in text
  const dateFormatPatterns = [
    // ISO 8601
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})/g,

    // Common date formats
    /\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?/g,
    /\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}(?::\d{2})?/g,

    // Date only formats
    /\d{4}-\d{2}-\d{2}/g,
    /\d{2}\/\d{2}\/\d{4}/g
  ];

  for (const pattern of dateFormatPatterns) {
    let dateMatch;
    while ((dateMatch = pattern.exec(html)) !== null) {
      const date = parseDate(dateMatch[0]);
      if (date) {
        results.push({
          type: 'visibleDate',
          date: date.toISOString(),
          context: html.substring(Math.max(0, dateMatch.index - 50),
                                 dateMatch.index + dateMatch[0].length + 50)
        });
      }
    }
  }

  // Update phrases with more variants
  const updatePhrasePattern = /(?:updated|last modified|modified|revised|last updated|posted|published)(?:\s*(?:on|at|date|time))?[:：]\s*([^<\n\r]{5,30})/gi;
  while ((match = updatePhrasePattern.exec(html)) !== null) {
    const dateStr = match[1].trim();
    const date = parseDate(dateStr);
    if (date) {
      results.push({
        type: 'updatePhrase',
        date: date.toISOString(),
        context: match[0],
        priority: 'high'
      });
    }
  }

  return results;
}


function extractUrlVersionIndicators(urlString) {
  const url = new URL(urlString);
  const results = {};

  // Check for version parameters
  const versionParams = ['v', 'ver', 'version', 'rev', 'revision', 'modified', 'updated', 'ts', 'timestamp'];
  for (const param of versionParams) {
    if (url.searchParams.has(param)) {
      results[param] = url.searchParams.get(param);
    }
  }

  // Check for date patterns in the path
  const pathParts = url.pathname.split('/');
  for (const part of pathParts) {
    // Check for YYYY/MM/DD pattern
    if (/^\d{4}\/\d{2}\/\d{2}$/.test(part.replace(/\//g, ''))) {
      results.dateInPath = part;
    }

    // Check for version numbers
    if (/^v\d+(\.\d+)*$/.test(part)) {
      results.versionInPath = part;
    }
  }

  return results;
}

function extractJavaScriptTimestamps(html) {
  const results = [];

  // Find timestamps in script tags
  const scriptPattern = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let scriptMatch;
  while ((scriptMatch = scriptPattern.exec(html)) !== null) {
    const scriptContent = scriptMatch[1];

    // Look for timestamp variables
    const timestampPatterns = [
      /(?:last_?(?:updated|modified)|modified_?(?:date|time)|update_?(?:date|time)|published_?(?:date|time))\s*[=:]\s*['"]?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})?)['"]?/i,
      /(?:last_?(?:updated|modified)|modified_?(?:date|time)|update_?(?:date|time)|published_?(?:date|time))\s*[=:]\s*new Date\(["']?([^)]+)["']?\)/i,
      /(?:last_?(?:updated|modified)|modified_?(?:date|time)|update_?(?:date|time)|published_?(?:date|time))\s*[=:]\s*(\d+)/i // Unix timestamp
    ];

    for (const pattern of timestampPatterns) {
      const match = scriptContent.match(pattern);
      if (match && match[1]) {
        let date;
        if (/^\d+$/.test(match[1])) {
          // Handle Unix timestamps (in seconds or milliseconds)
          const timestamp = parseInt(match[1]);
          date = new Date(timestamp > 9999999999 ? timestamp : timestamp * 1000);
        } else {
          date = new Date(match[1]);
        }

        if (!isNaN(date.getTime())) {
          results.push({
            type: 'jsTimestamp',
            date: date.toISOString(),
            context: match[0]
          });
        }
      }
    }

    // Look for data objects with date properties
    const dataObjectPattern = /(?:article|page|post|document|content|data)(?:Data)?\s*[=:]\s*\{[\s\S]*?(?:updated|modified|published|date)(?:At|On|Date|Time)?\s*[=:]\s*["']?([^,"'\}\s]+)["']?/i;
    const dataObjectMatch = scriptContent.match(dataObjectPattern);
    if (dataObjectMatch && dataObjectMatch[1]) {
      const date = new Date(dataObjectMatch[1]);
      if (!isNaN(date.getTime())) {
        results.push({
          type: 'jsDataObject',
          date: date.toISOString(),
          context: dataObjectMatch[0].substring(0, 100)
        });
      }
    }
  }

  // Look for JSON-LD scripts which often contain date information
  const jsonLdPattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let jsonLdMatch;
  while ((jsonLdMatch = jsonLdPattern.exec(html)) !== null) {
    try {
      const jsonLd = JSON.parse(jsonLdMatch[1]);

      // Extract dates from JSON-LD
      const dateFields = ['dateModified', 'dateUpdated', 'datePublished', 'uploadDate'];
      for (const field of dateFields) {
        if (jsonLd[field]) {
          const date = new Date(jsonLd[field]);
          if (!isNaN(date.getTime())) {
            results.push({
              type: 'jsonLd',
              field: field,
              date: date.toISOString(),
              priority: field === 'dateModified' ? 'high' : 'medium'
            });
          }
        }
      }
    } catch (e) {
      // Invalid JSON, skip this script
    }
  }

  return results;
}

function extractResourceTimestamps(html) {
  const results = {};

  // CSS files with version/timestamp parameters
  const cssLinkPattern = /<link[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi;
  let cssMatch;
  const cssVersions = [];
  while ((cssMatch = cssLinkPattern.exec(html)) !== null) {
    const href = cssMatch[1];
    const url = new URL(href, 'http://example.com'); // Base URL doesn't matter for parameter extraction

    // Check for version or timestamp parameters
    for (const [key, value] of url.searchParams.entries()) {
      if (['v', 'ver', 'version', 'rev', 'timestamp', 'ts', 't', 'modified'].includes(key.toLowerCase())) {
        cssVersions.push({
          param: key,
          value: value,
          timestamp: extractPossibleTimestamp(value)
        });
      }
    }
  }

  if (cssVersions.length > 0) {
    results.cssVersions = cssVersions;
  }

  // JavaScript files with version/timestamp parameters
  const jsScriptPattern = /<script[^>]*src=["']([^"']+)["'][^>]*>/gi;
  let jsMatch;
  const jsVersions = [];
  while ((jsMatch = jsScriptPattern.exec(html)) !== null) {
    const src = jsMatch[1];
    const url = new URL(src, 'http://example.com');

    for (const [key, value] of url.searchParams.entries()) {
      if (['v', 'ver', 'version', 'rev', 'timestamp', 'ts', 't', 'modified'].includes(key.toLowerCase())) {
        jsVersions.push({
          param: key,
          value: value,
          timestamp: extractPossibleTimestamp(value)
        });
      }
    }
  }

  if (jsVersions.length > 0) {
    results.jsVersions = jsVersions;
  }

  return results;
}

function extractPossibleTimestamp(value) {
  // Check if the value is a Unix timestamp
  if (/^\d{10,13}$/.test(value)) {
    const timestamp = parseInt(value);
    const date = new Date(timestamp > 9999999999 ? timestamp : timestamp * 1000);
    if (!isNaN(date.getTime()) && date.getFullYear() > 2000 && date.getFullYear() < 2050) {
      return date.toISOString();
    }
  }
  return null;
}

function extractCMSSpecificTimestamps(html) {
  const results = {};

  // WordPress
  const wpPattern = /<meta name="generator" content="WordPress ([^"]+)"/i;
  const wpMatch = html.match(wpPattern);
  if (wpMatch) {
    results.cms = 'WordPress';

    // WordPress typically has wp-json API endpoint that includes modified dates
    const wpJsonPattern = /<link rel="https:\/\/api\.w\.org\/" href="([^"]+)"/i;
    const wpJsonMatch = html.match(wpJsonPattern);
    if (wpJsonMatch) {
      results.wpJsonEndpoint = wpJsonMatch[1];
    }

    // Look for post modified time
    const wpModifiedPattern = /<time class="(?:[^"]*\s)?(?:updated|modified)(?:\s[^"]*)?" datetime="([^"]+)"/i;
    const wpModifiedMatch = html.match(wpModifiedPattern);
    if (wpModifiedMatch) {
      const date = new Date(wpModifiedMatch[1]);
      if (!isNaN(date.getTime())) {
        results.wpModifiedTime = date.toISOString();
      }
    }
  }

  // Drupal
  const drupalPattern = /<meta name="Generator" content="Drupal ([^"]+)"/i;
  const drupalMatch = html.match(drupalPattern);
  if (drupalMatch) {
    results.cms = 'Drupal';

    // Drupal often has a node-changed-time class
    const drupalTimePattern = /<[^>]*class="[^"]*node-changed-date[^"]*"[^>]*>([^<]+)/i;
    const drupalTimeMatch = html.match(drupalTimePattern);
    if (drupalTimeMatch) {
      const date = new Date(drupalTimeMatch[1]);
      if (!isNaN(date.getTime())) {
        results.drupalModifiedTime = date.toISOString();
      }
    }
  }

  // Joomla
  const joomlaPattern = /<meta name="generator" content="Joomla! ([^"]+)"/i;
  const joomlaMatch = html.match(joomlaPattern);
  if (joomlaMatch) {
    results.cms = 'Joomla';

    // Joomla uses modified dates in article info
    const joomlaTimePattern = /<dd class="modified">[^<]*<time datetime="([^"]+)"/i;
    const joomlaTimeMatch = html.match(joomlaTimePattern);
    if (joomlaTimeMatch) {
      const date = new Date(joomlaTimeMatch[1]);
      if (!isNaN(date.getTime())) {
        results.joomlaModifiedTime = date.toISOString();
      }
    }
  }

  // Ghost CMS
  const ghostPattern = /<meta name="generator" content="Ghost ([^"]+)"/i;
  const ghostMatch = html.match(ghostPattern);
  if (ghostMatch) {
    results.cms = 'Ghost';

    // Ghost uses updated-at in article footer
    const ghostTimePattern = /<time class="updated" datetime="([^"]+)"/i;
    const ghostTimeMatch = html.match(ghostTimePattern);
    if (ghostTimeMatch) {
      const date = new Date(ghostTimeMatch[1]);
      if (!isNaN(date.getTime())) {
        results.ghostModifiedTime = date.toISOString();
      }
    }
  }

  return results;
}

function extractCopyrightYears(html) {
  // Copyright statements can give a clue about the last update year
  const results = {};

  // Look for copyright years
  const copyrightPattern = /(?:©|&copy;|Copyright(?:\s+©)?)\s*(?:\d{4}\s*[-–—]\s*)?(\d{4})/i;
  const copyrightMatch = html.match(copyrightPattern);
  if (copyrightMatch) {
    const year = parseInt(copyrightMatch[1]);
    if (year >= 2000 && year <= new Date().getFullYear()) {
      results.year = year;
      results.statement = copyrightMatch[0];
    }
  }

  return results;
}

async function extractSitemapLastmod(pageUrl) {
  try {
    // Try to find and fetch the sitemap
    const urlObj = new URL(pageUrl);
    const sitemapUrl = `${urlObj.protocol}//${urlObj.hostname}/sitemap.xml`;

    const response = await fetch(sitemapUrl);
    if (!response.ok) return null;

    const text = await response.text();

    // Find the URL entry for this page
    const urlPath = urlObj.pathname + urlObj.search;
    const urlPattern = new RegExp(`<url>\\s*<loc>(?:[^<]*${escapeRegExp(urlPath)}[^<]*)</loc>\\s*<lastmod>([^<]+)</lastmod>`, 'i');
    const urlMatch = text.match(urlPattern);

    if (urlMatch && urlMatch[1]) {
      const date = new Date(urlMatch[1]);
      if (!isNaN(date.getTime())) {
        return date.toISOString();
      }
    }

    return null;
  } catch (error) {
    return null;
  }
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function generateDOMFingerprint(html) {
  // Generate a structural fingerprint of the DOM
  // This helps detect changes in layout even if no explicit timestamps are found

  // Extract all HTML element tags and their count
  const tagPattern = /<([a-z][a-z0-9]*)\b[^>]*>/gi;
  const tags = {};
  let match;

  while ((match = tagPattern.exec(html)) !== null) {
    const tag = match[1].toLowerCase();
    tags[tag] = (tags[tag] || 0) + 1;
  }

  // Count total words as part of fingerprint
  const wordCount = html.replace(/<[^>]*>/g, ' ')  // Remove HTML tags
                      .replace(/\s+/g, ' ')        // Normalize whitespace
                      .trim()
                      .split(' ')
                      .length;

  return {
    tags,
    wordCount,
    contentLength: html.length,
    tagCount: Object.values(tags).reduce((a, b) => a + b, 0)
  };
}

// Advanced content fingerprinting for change detection
async function generateContentFingerprint(html) {
  // Remove parts that change frequently but don't represent content updates
  const cleanHtml = html
    // Remove comments
    .replace(/<!--[\s\S]*?-->/g, '')
    // Remove scripts (except JSON-LD which might contain valuable metadata)
    .replace(/<script(?!\s+type=["']application\/ld\+json["'])[^>]*>[\s\S]*?<\/script>/gi, '')
    // Remove style tags
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    // Remove CSS classes (often change but don't affect content)
    .replace(/\sclass=["'][^"']*["']/gi, '')
    // Remove dynamic IDs
    .replace(/\sid=["'][^"']*["']/gi, '')
    // Replace consecutive whitespace with single space
    .replace(/\s+/g, ' ');

  // Extract main content (heuristic: largest chunk of text without HTML tags)
  const bodyContent = cleanHtml.replace(/<head[\s\S]*?<\/head>/i, '');
  const textBlocks = bodyContent.split(/<[^>]+>/).filter(block => block.trim().length > 100);

  // Sort blocks by length (descending) to find main content
  textBlocks.sort((a, b) => b.length - a.length);

  // Generate hash of the full document and main content block
  const encoder = new TextEncoder();
  const fullData = encoder.encode(cleanHtml);
  const fullHashBuffer = await crypto.subtle.digest('SHA-256', fullData);
  const fullHash = Array.from(new Uint8Array(fullHashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Generate hash of just the main content
  const mainContentHash = textBlocks.length > 0 ?
    await crypto.subtle.digest('SHA-256', encoder.encode(textBlocks[0]))
      .then(buf => Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')) :
    null;

  return {
    fullDocumentHash: fullHash,
    mainContentHash: mainContentHash,
    pageLength: html.length,
    cleanedLength: cleanHtml.length,
    mainContentLength: textBlocks.length > 0 ? textBlocks[0].length : 0,
    textBlocksCount: textBlocks.length
  };
}

// Modify hasValidTimestamp to include new sources
function hasValidTimestamp(result) {
  // Check if we found any valid timestamps
  if (result.lastModified) return true;
  if (result.metaTags && Object.keys(result.metaTags).length > 0) return true;
  if (result.visibleDates && result.visibleDates.length > 0) return true;
  if (result.jsTimestamps && result.jsTimestamps.length > 0) return true;
  if (result.schemaOrgTimestamps && result.schemaOrgTimestamps.length > 0) return true;
  if (result.htmlComments && result.htmlComments.length > 0) return true;
  if (result.gitInfo && (result.gitInfo.gitDate || result.gitInfo.deployDate)) return true;
  if (result.cmsSpecificTimestamps &&
      (result.cmsSpecificTimestamps.wpModifiedTime ||
       result.cmsSpecificTimestamps.drupalModifiedTime ||
       result.cmsSpecificTimestamps.joomlaModifiedTime ||
       result.cmsSpecificTimestamps.ghostModifiedTime)) return true;

  return false;
}

function determineBestUpdateTime(updateTimes) {
  // First check for meta tags that explicitly indicate last modified time
  if (updateTimes.metaTags && updateTimes.metaTags.lastModified) {
    // Meta tag with explicit lastmodified takes highest priority
    return {
      timestamp: updateTimes.metaTags.lastModified,
      confidence: 95,
      reasoning: ["Explicit lastmodifiedtime meta tag"]
    };
  }

  // Check other meta tags related to publication/modification
  if (updateTimes.metaTags) {
    if (updateTimes.metaTags.articleModified) {
      return {
        timestamp: updateTimes.metaTags.articleModified,
        confidence: 90,
        reasoning: ["Article modified time meta tag"]
      };
    }

    if (updateTimes.metaTags.publishedDate) {
      return {
        timestamp: updateTimes.metaTags.publishedDate,
        confidence: 85,
        reasoning: ["Published date meta tag"]
      };
    }
  }

  // Check visible dates with high priority markers
  if (updateTimes.visibleDates && updateTimes.visibleDates.length > 0) {
    // Look for dates that appear to be part of lastmodified content
    const contentDates = updateTimes.visibleDates.filter(d => {
      const ctx = d.context.toLowerCase();
      return ctx.includes('lastmodified') ||
             ctx.includes('last modified') ||
             ctx.includes('updated') ||
             ctx.includes('修改') ||  // Chinese for "modified"
             ctx.includes('更新');    // Chinese for "updated"
    });

    if (contentDates.length > 0) {
      // Sort by recency
      const dates = contentDates.map(d => new Date(d.date));
      dates.sort((a, b) => {
        if (!a || !b) return 0;
        return b.getTime() - a.getTime();
      });

      return {
        timestamp: dates[0].toISOString(),
        confidence: 92,
        reasoning: ["Content explicitly marked as modified/updated"]
      };
    }

    // Next check for dates that appear in common date display elements
    const displayDateElements = updateTimes.visibleDates.filter(d => {
      const ctx = d.context.toLowerCase();
      return ctx.includes('class="date') ||
             ctx.includes('class="time') ||
             ctx.includes('class="pubdate') ||
             ctx.includes('class="published') ||
             ctx.includes('pages-date') ||
             ctx.includes('pub-date');
    });

    if (displayDateElements.length > 0) {
      const dates = displayDateElements.map(d => new Date(d.date));
      dates.sort((a, b) => b.getTime() - a.getTime());

      return {
        timestamp: dates[0].toISOString(),
        confidence: 88,
        reasoning: ["Date from primary content display element"]
      };
    }
  }

  // Check for Schema.org timestamps
  if (updateTimes.schemaOrgTimestamps && updateTimes.schemaOrgTimestamps.length > 0) {
    // Filter for high priority fields: dateModified and dateUpdated
    const highPriorityDates = updateTimes.schemaOrgTimestamps
      .filter(stamp => stamp.priority === 'high')
      .map(stamp => ({ date: new Date(stamp.date), field: stamp.field, context: stamp.context }));

    if (highPriorityDates.length > 0) {
      // Sort by recency
      highPriorityDates.sort((a, b) => b.date.getTime() - a.date.getTime());

      return {
        timestamp: highPriorityDates[0].date.toISOString(),
        confidence: 85,
        reasoning: ["Schema.org structured data", `Field: ${highPriorityDates[0].field}`, `Context: ${highPriorityDates[0].context}`]
      };
    }

    // If no high priority fields, use most recent Schema.org date
    const allSchemaDates = updateTimes.schemaOrgTimestamps
      .map(stamp => ({ date: new Date(stamp.date), field: stamp.field, context: stamp.context }));

    allSchemaDates.sort((a, b) => b.date.getTime() - a.date.getTime());

    return {
      timestamp: allSchemaDates[0].date.toISOString(),
      confidence: 75,
      reasoning: ["Schema.org structured data", `Field: ${allSchemaDates[0].field}`, `Context: ${allSchemaDates[0].context}`]
    };
  }

  // Check Git info (often very reliable)
  if (updateTimes.gitInfo && updateTimes.gitInfo.gitDate) {
    return {
      timestamp: updateTimes.gitInfo.gitDate,
      confidence: 90,
      reasoning: ["Git commit information", updateTimes.gitInfo.gitHash ? `Git hash: ${updateTimes.gitInfo.gitHash}` : ""]
    };
  } else if (updateTimes.gitInfo && updateTimes.gitInfo.deployDate) {
    return {
      timestamp: updateTimes.gitInfo.deployDate,
      confidence: 88,
      reasoning: ["Git deployment timestamp"]
    };
  }

  // Check CMS-specific timestamps - these are usually reliable
  if (updateTimes.cmsSpecificTimestamps) {
    const cms = updateTimes.cmsSpecificTimestamps.cms;
    if (cms) {
      // Get the CMS-specific timestamp
      let cmsDate = null;
      if (cms === 'WordPress' && updateTimes.cmsSpecificTimestamps.wpModifiedTime) {
        cmsDate = new Date(updateTimes.cmsSpecificTimestamps.wpModifiedTime);
      } else if (cms === 'Drupal' && updateTimes.cmsSpecificTimestamps.drupalModifiedTime) {
        cmsDate = new Date(updateTimes.cmsSpecificTimestamps.drupalModifiedTime);
      } else if (cms === 'Joomla' && updateTimes.cmsSpecificTimestamps.joomlaModifiedTime) {
        cmsDate = new Date(updateTimes.cmsSpecificTimestamps.joomlaModifiedTime);
      } else if (cms === 'Ghost' && updateTimes.cmsSpecificTimestamps.ghostModifiedTime) {
        cmsDate = new Date(updateTimes.cmsSpecificTimestamps.ghostModifiedTime);
      }

      if (cmsDate && !isNaN(cmsDate.getTime())) {
        return {
          timestamp: cmsDate.toISOString(),
          confidence: 80,
          reasoning: [`${cms} CMS timestamp detected`]
        };
      }
    }
  }

  // JSON-LD structured data is also quite reliable
  if (updateTimes.jsTimestamps && updateTimes.jsTimestamps.length > 0) {
    const jsonLdDates = updateTimes.jsTimestamps
      .filter(stamp => stamp.type === 'jsonLd')
      .map(stamp => ({
        date: new Date(stamp.date),
        field: stamp.field,
        priority: stamp.priority
      }));

    if (jsonLdDates.length > 0) {
      // Sort by priority and recency
      jsonLdDates.sort((a, b) => {
        if (a.priority === 'high' && b.priority !== 'high') return -1;
        if (a.priority !== 'high' && b.priority === 'high') return 1;
        return b.date.getTime() - a.date.getTime();
      });

      return {
        timestamp: jsonLdDates[0].date.toISOString(),
        confidence: jsonLdDates[0].priority === 'high' ? 80 : 65,
        reasoning: [`JSON-LD structured data (${jsonLdDates[0].field})`]
      };
    }
  }

  // If we have a page generation time meta tag, it's a decent indicator
  if (updateTimes.metaTags && updateTimes.metaTags.pageGenerated) {
    return {
      timestamp: updateTimes.metaTags.pageGenerated,
      confidence: 75,
      reasoning: ["Page generation time meta tag"]
    };
  }

  // Process visible dates that don't have explicit modification indicators
  if (updateTimes.visibleDates && updateTimes.visibleDates.length > 0) {
    // Get all dates and sort by recency
    const allDates = updateTimes.visibleDates.map(d => ({
      date: new Date(d.date),
      context: d.context
    }));

    allDates.sort((a, b) => b.date.getTime() - a.date.getTime());

    return {
      timestamp: allDates[0].date.toISOString(),
      confidence: 70,
      reasoning: ["Most recent date found in page content", `Context: "${allDates[0].context}"`]
    };
  }

  // Only now check HTTP Last-Modified header, and only if it's different from server time
  if (updateTimes.lastModified && updateTimes.date) {
    const lastModDate = new Date(updateTimes.lastModified);
    const serverDate = new Date(updateTimes.date);

    // If lastModified is significantly different from server time (more than 1 minute)
    // then it might be meaningful. Otherwise, it's likely just the same as server time.
    if (Math.abs(lastModDate.getTime() - serverDate.getTime()) > 60000) {
      return {
        timestamp: lastModDate.toISOString(),
        confidence: 65,
        reasoning: ["HTTP Last-Modified header differs from server time"]
      };
    }
  }

  // Try HTML comments
  if (updateTimes.htmlComments && updateTimes.htmlComments.length > 0) {
    const commentDates = updateTimes.htmlComments.map(c => ({
      date: new Date(c.date),
      context: c.context
    }));

    commentDates.sort((a, b) => b.date.getTime() - a.date.getTime());

    return {
      timestamp: commentDates[0].date.toISOString(),
      confidence: 60,
      reasoning: ["Timestamp from HTML comment", `Context: "${commentDates[0].context}"`]
    };
  }

  // Try JavaScript timestamps
  if (updateTimes.jsTimestamps && updateTimes.jsTimestamps.length > 0) {
    const jsDates = updateTimes.jsTimestamps
      .filter(stamp => stamp.type !== 'jsonLd')
      .map(stamp => ({
        date: new Date(stamp.date),
        context: stamp.context,
        type: stamp.type
      }));

    if (jsDates.length > 0) {
      // Sort by recency
      jsDates.sort((a, b) => b.date.getTime() - a.date.getTime());

      return {
        timestamp: jsDates[0].date.toISOString(),
        confidence: 60,
        reasoning: ["JavaScript timestamp found", `Context: "${jsDates[0].context}"`]
      };
    }
  }

  // Try sitemap lastmod if available
  if (updateTimes.sitemapLastmod) {
    const sitemapDate = new Date(updateTimes.sitemapLastmod);
    if (!isNaN(sitemapDate.getTime())) {
      return {
        timestamp: sitemapDate.toISOString(),
        confidence: 70,
        reasoning: ["Timestamp from sitemap.xml"]
      };
    }
  }

  // Try resource timestamps
  if (updateTimes.resourceTimestamps) {
    // Look for timestamps in CSS or JS versioning parameters
    const timestamps = [];

    if (updateTimes.resourceTimestamps.cssVersions) {
      for (const item of updateTimes.resourceTimestamps.cssVersions) {
        if (item.timestamp) {
          timestamps.push({
            date: new Date(item.timestamp),
            source: `CSS parameter: ${item.param}`
          });
        }
      }
    }

    if (updateTimes.resourceTimestamps.jsVersions) {
      for (const item of updateTimes.resourceTimestamps.jsVersions) {
        if (item.timestamp) {
          timestamps.push({
            date: new Date(item.timestamp),
            source: `JS parameter: ${item.param}`
          });
        }
      }
    }

    if (timestamps.length > 0) {
      // Sort by recency
      timestamps.sort((a, b) => b.date.getTime() - a.date.getTime());

      return {
        timestamp: timestamps[0].date.toISOString(),
        confidence: 50,
        reasoning: ["Resource versioning timestamp", `Source: ${timestamps[0].source}`]
      };
    }
  }

  // Check copyright year as a last resort
  if (updateTimes.copyrightYears && updateTimes.copyrightYears.year) {
    const currentYear = new Date().getFullYear();
    const copyrightYear = updateTimes.copyrightYears.year;

    // If copyright year is current year, use current date with low confidence
    if (copyrightYear === currentYear) {
      return {
        timestamp: new Date().toISOString(),
        confidence: 30,
        reasoning: ["Current year in copyright notice", "Exact date unknown"]
      };
    } else if (copyrightYear < currentYear) {
      // If copyright year is not current, use Dec 31 of that year
      return {
        timestamp: new Date(copyrightYear, 11, 31).toISOString(),
        confidence: 20,
        reasoning: ["Past year in copyright notice", "Page likely not updated since that year"]
      };
    }
  }

  // Use HTTP Last-Modified even if it matches server time, but with lower confidence
  if (updateTimes.lastModified) {
    const lastModDate = new Date(updateTimes.lastModified);
    if (!isNaN(lastModDate.getTime())) {
      return {
        timestamp: lastModDate.toISOString(),
        confidence: 40,
        reasoning: ["HTTP Last-Modified header (may be server time)"]
      };
    }
  }

  // If all else fails, use the server date with very low confidence
  if (updateTimes.date) {
    return {
      timestamp: new Date(updateTimes.date).toISOString(),
      confidence: 10,
      reasoning: ["No update time found", "Using server date as fallback"]
    };
  }

  // Absolute fallback: unknown
  return {
    timestamp: null,
    confidence: 0,
    reasoning: ["No reliable update time indicators found"]
  };
}