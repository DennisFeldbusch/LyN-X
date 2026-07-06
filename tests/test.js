const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const crypto = require('crypto');
const puppeteer = require('puppeteer');

// Helper function to normalize URLs - add protocol if missing
function normalizeUrl(urlString) {
  if (!urlString || urlString.trim() === '') {
    return urlString;
  }
  
  const trimmed = urlString.trim();
  
  // Check if URL already has a protocol
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }
  
  // Add https:// if no protocol is specified
  return `https://${trimmed}`;
}

// Parse CLI arguments
const args = process.argv.slice(2);
const urlFlag = args.find(arg => arg.startsWith('--url='));
const urlListFlag = args.find(arg => arg.startsWith('--url-list='));
const outputFlag = args.find(arg => arg.startsWith('--output='));
const looseMatchingFlag = args.includes('--loose');

if (!urlFlag && !urlListFlag) {
  console.error('Usage:');
  console.error('  Single URL mode:');
  console.error('    node test.js --url=<URL> [--output=<file.json|file.csv>] [--loose]');
  console.error('');
  console.error('  Batch mode (multiple URLs):');
  console.error('    node test.js --url-list=<file> [--output=<dir>] [--loose]');
  console.error('    (file should contain one URL per line, lines starting with # are ignored)');
  console.error('');
  console.error('  Options:');
  console.error('    --loose        Enable loose matching mode (contains check instead of exact match)');
  process.exit(1);
}

if (urlFlag && urlListFlag) {
  console.error('Error: Cannot specify both --url and --url-list');
  process.exit(1);
}

let targetUrl = null;
let urlList = [];
let isBatchMode = false;
let outputFile = null;

if (urlFlag) {
  targetUrl = urlFlag.split('=')[1];
  outputFile = outputFlag ? outputFlag.split('=')[1] : null;
  
  if (!targetUrl) {
    console.error('Error: URL not provided after --url=');
    process.exit(1);
  }
  
  // Normalize URL - add https:// if protocol missing
  targetUrl = normalizeUrl(targetUrl);
  
  const matchMode = looseMatchingFlag ? '(LOOSE MODE)' : '';
  console.log(`\n🔍 Starting test with URL: ${targetUrl} ${matchMode}\n`);
} else {
  // Batch mode
  isBatchMode = true;
  const urlListPath = urlListFlag.split('=')[1];
  
  if (!urlListPath) {
    console.error('Error: URL list file not provided after --url-list=');
    process.exit(1);
  }
  
  if (!fs.existsSync(urlListPath)) {
    console.error(`Error: URL list file not found: ${urlListPath}`);
    process.exit(1);
  }
  
  // Read and parse URLs from file
  const fileContent = fs.readFileSync(urlListPath, 'utf-8');
  urlList = fileContent
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
    .map(line => normalizeUrl(line)); // Normalize all URLs
  
  if (urlList.length === 0) {
    console.error('Error: No valid URLs found in URL list file');
    process.exit(1);
  }
  
  outputFile = outputFlag ? outputFlag.split('=')[1] : 'results';
  
  console.log(`\n🔄 Batch mode: Processing ${urlList.length} URLs`);
  console.log(`📊 Results will be saved to: ${outputFile}/\n`);
}

// Helper function to download a file
function downloadFile(fileUrl, destPath, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    try {
      // Ensure the directory exists before creating the write stream
      const dir = path.dirname(destPath);
      fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      reject(new Error(`Failed to create directory: ${error.message}`));
      return;
    }
    
    const protocol = fileUrl.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    file.on('error', error => {
      reject(error);
    });
    
    // Set both request timeout and download timeout
    const request = protocol.get(fileUrl, response => {
      // Set a timeout on the response if data isn't received
      const dataTimeout = setTimeout(() => {
        request.abort();
        file.destroy();
        fs.unlink(destPath, () => {}); // Delete partial file
        reject(new Error(`Download timeout after ${timeoutMs}ms - no data received`));
      }, timeoutMs);
      
      response.on('data', () => {
        clearTimeout(dataTimeout); // Reset timeout on each data chunk
      });
      
      response.pipe(file);
      file.on('finish', () => {
        clearTimeout(dataTimeout);
        file.close();
        resolve(destPath);
      });
    }).on('error', error => {
      file.destroy();
      fs.unlink(destPath, () => {}); // Delete partial file
      reject(error);
    });
    
    // Set request connection timeout
    request.setTimeout(timeoutMs, () => {
      request.abort();
      reject(new Error(`Request timeout after ${timeoutMs}ms`));
    });
  });
}

// Helper function to generate a safe filename from a URL
function generateSafeFilename(url, index) {
  if (!url || url.trim() === '') {
    return `file_${index}.js`; // Fallback for empty URLs
  }
  
  try {
    const urlObj = new URL(url);
    let filename = path.basename(urlObj.pathname).split('?')[0];
    
    if (!filename || filename === '') {
      // If basename is empty, use domain + index
      filename = `${urlObj.hostname}_${index}.js`;
    }
    
    // Sanitize filename - remove special chars
    filename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    
    // IMPORTANT: Limit filename length to avoid ENAMETOOLONG errors
    // Filesystem limit is typically 255 chars, we'll stay well under it
    const MAX_FILENAME_LENGTH = 200;
    
    if (filename.length > MAX_FILENAME_LENGTH) {
      // If filename is too long, use a hash-based approach for uniqueness
      // Extract extension
      const ext = path.extname(filename);
      const nameWithoutExt = filename.slice(0, -ext.length);
      
      // Create a short hash of the full URL for uniqueness
      const urlHash = crypto.createHash('md5').update(url).digest('hex').slice(0, 8);
      
      // Use truncated name + hash + extension
      const truncatedName = nameWithoutExt.slice(0, 80); // Keep first 80 chars
      filename = `${index}_${truncatedName}_${urlHash}${ext}`;
    }
    
    return filename;
  } catch (e) {
    // If URL parsing fails, use index-based name
    return `file_${index}.js`;
  }
}

// Helper function to extract known segments from text containing variable placeholders
function extractKnownSegments(text) {
  // Split by common delimiters and filter out variable placeholders
  let segments = text
    .split(/[\/\?\#&=]/) // Split by URL delimiters
    .filter(s => s.length > 0)
    .filter(s => !s.match(/^\{VAR:[^}]*\}$/) && !s.match(/^\{CALL:[^}]*\}$/)); // Exclude pure placeholders
  
  // Strip variable/call prefixes from segments that start with {VAR:...} or {CALL:...}
  // e.g., {VAR:f.p}62758-90f5c6b8a7745117 -> 62758-90f5c6b8a7745117
  segments = segments.map(s => {
    // Match and remove {VAR:...} prefix
    let cleaned = s.replace(/^\{VAR:[^}]*\}/, '');
    // Match and remove {CALL:...} prefix
    cleaned = cleaned.replace(/^\{CALL:[^}]*\}/, '');
    return cleaned;
  })
  .filter(s => s.length > 0); // Remove any empty strings after prefix stripping
  
  return segments;
}

// Helper function to extract URLs from Lynx table output
function extractUrlsFromLynxTable(lynxOutput) {
  const urls = [];
  const urlSet = new Set(); // Track unique URLs
  const lines = lynxOutput.split('\n');
  
  for (const line of lines) {
    // Skip header lines and separator lines
    if (line.includes('LINE') || line.includes('---') || !line.includes('|')) {
      continue;
    }
    
    // Split by pipe to get columns: LINE | SINK | URL
    const parts = line.split('|');
    if (parts.length >= 3) {
      const urlPart = parts[2].trim(); // Get the URL column (third column)
      if (urlPart && urlPart.length > 0 && !urlSet.has(urlPart)) {
        urls.push(urlPart);
        urlSet.add(urlPart);
      }
    }
  }
  

  return urls;
}

// Helper function to check if URL is found in Lynx output, handling variable placeholders
function isUrlInLynxOutput(targetUrl, lynxOutput) {
  try {
    // Extract URL values from the Lynx table
    const lynxUrls = extractUrlsFromLynxTable(lynxOutput);
    
    if (lynxUrls.length === 0) {
      return false;
    }
    
    // Extract known segments from target URL
    const urlObj = new URL(targetUrl);
    const targetUrlStr = urlObj.toString();
    const targetKnownSegments = extractKnownSegments(targetUrlStr);
    
    if (targetKnownSegments.length === 0) {
      return false;
    }
    
    // Check each URL from Lynx output
    for (let urlIndex = 0; urlIndex < lynxUrls.length; urlIndex++) {
      const lynxUrl = lynxUrls[urlIndex];
      
      // Extract known segments from this Lynx URL
      const lynxKnownSegments = extractKnownSegments(lynxUrl);
      
      // Must have at least 1 meaningful segment for matching
      if (lynxKnownSegments.length === 0) {
        continue;
      }
      
      // Check if all Lynx known segments appear in target URL
      let allFound = true;
      const matchedSegments = [];
      
      for (const lynxSegment of lynxKnownSegments) {
        let found = false;
        
        // Search for this segment in target
        for (const targetSegment of targetKnownSegments) {
          if (targetSegment.includes(lynxSegment) || lynxSegment.includes(targetSegment)) {
            matchedSegments.push(lynxSegment);
            found = true;
            break;
          }
        }
        
        if (!found) {
          allFound = false;
          break;
        }
      }
      
      if (allFound && matchedSegments.length > 0) {
        return true;
      }
    }
    
    return false;
    
  } catch (e) {
    return false;
  }
}

// Helper function to strip query string from URL (remove everything after ?)
function stripQueryString(url) {
  const questionMarkIndex = url.indexOf('?');
  if (questionMarkIndex !== -1) {
    return url.substring(0, questionMarkIndex);
  }
  return url;
}

// Helper function to convert a LYN-X extracted URL to a regex pattern
// Replaces {VAR:*} and {CALL:*} with wildcards (.*?)
function urlToRegexPattern(lynxUrl) {
  // First, strip query string
  let pattern = stripQueryString(lynxUrl);
  
  // First, replace placeholders with a temporary marker
  pattern = pattern.replace(/\{VAR:[^}]*\}/g, '__PLACEHOLDER__').replace(/\{CALL:[^}]*\}/g, '__PLACEHOLDER__');
  
  // Escape all special regex characters
  pattern = pattern.replace(/[.+^$|()[\]{}]/g, '\\$&').replace(/\?/g, '\\?');
  
  // Replace our marker with the actual wildcard regex
  pattern = pattern.replace(/__PLACEHOLDER__/g, '.*?');
  
  return pattern;
}

// Helper function to check if a LYN-X URL has a domain component
function hasDomain(lynxUrl) {
  // A URL has a domain if it starts with http:// or https://, or contains ://
  return /^https?:\/\//.test(lynxUrl) || lynxUrl.includes('://');
}

// Helper function to extract domain from URL
function extractDomain(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.origin; // e.g., https://example.com
  } catch (e) {
    return null;
  }
}

// Helper function to classify match using LOOSE mode (wildcard matching)
// In loose mode, the regex pattern has implicit wildcards at beginning and end
// Example: https://domain.com/api/{VAR:n}/test/ matches https://domain.com/api/v1/test/check
function classifyMatchLoose(lynxUrl, groundTruthUrl) {
  try {
    // Handle empty URLs
    if (!lynxUrl || lynxUrl.trim() === '' || !groundTruthUrl || groundTruthUrl.trim() === '') {
      return { type: 'no_match', confidence: 0.0 };
    }
    
    // Strip query strings from both URLs
    const lynxUrlNoQuery = stripQueryString(lynxUrl);
    const groundTruthUrlNoQuery = stripQueryString(groundTruthUrl);
    
    // Check for exact string match first
    if (lynxUrlNoQuery === groundTruthUrlNoQuery) {
      return { type: 'exact_match', confidence: 1.0 };
    }
    
    // Convert LYN-X URL to regex pattern (like strict mode)
    const regexPattern = urlToRegexPattern(lynxUrl);
    let regex;
    try {
      // In loose mode, prepend and append .* to allow anything before and after
      regex = new RegExp(`.*${regexPattern}.*`);
    } catch (e) {
      // If regex compilation fails, no match
      return { type: 'no_match', confidence: 0.0 };
    }
    
    // Test if ground truth URL (without query) matches the regex with loose wildcards
    if (!regex.test(groundTruthUrlNoQuery)) {
      return { type: 'no_match', confidence: 0.0 };
    }
    
    // The URL matches! Return partial match since it's loose matching
    return { type: 'partial_match', confidence: 0.95 };
    
  } catch (e) {
    return { type: 'no_match', confidence: 0.0 };
  }
}

// Helper function to classify match type between extracted and ground truth URLs using regex
function classifyMatch(extractedUrl, groundTruthUrl, useLooseMatching = false) {
  try {
    // Handle empty URLs
    if (!extractedUrl || extractedUrl.trim() === '' || !groundTruthUrl || groundTruthUrl.trim() === '') {
      return { type: 'no_match', confidence: 0.0 };
    }
    
    // If loose matching mode is enabled, use loose matching logic
    if (useLooseMatching) {
      return classifyMatchLoose(extractedUrl, groundTruthUrl);
    }
    
    // Strip query strings from both URLs before comparison
    const extractedUrlNoQuery = stripQueryString(extractedUrl);
    const groundTruthUrlNoQuery = stripQueryString(groundTruthUrl);
    
    // Check for exact string match first
    if (extractedUrlNoQuery === groundTruthUrlNoQuery) {
      return { type: 'exact_match', confidence: 1.0 };
    }
    
    // Convert LYN-X URL to regex pattern (query string already stripped in the function)
    const regexPattern = urlToRegexPattern(extractedUrl);
    let regex;
    try {
      regex = new RegExp(`^${regexPattern}$`);
    } catch (e) {
      // If regex compilation fails, no match
      return { type: 'no_match', confidence: 0.0 };
    }
    
    // Test if ground truth URL (without query) matches the regex
    if (!regex.test(groundTruthUrlNoQuery)) {
      return { type: 'no_match', confidence: 0.0 };
    }
    
    // The URL matches! Now determine if it's exact or partial match
    const lynxHasDomain = hasDomain(extractedUrlNoQuery);
    
    if (!lynxHasDomain) {
      // If the LYN-X URL has no domain but the path matches, it's a partial match
      // (because the domain is missing/undefined)
      return { type: 'partial_match', confidence: 0.95 };
    }
    
    // If LYN-X has a domain, check if the domain matches the ground truth domain
    try {
      const lynxDomain = extractDomain(extractedUrlNoQuery);
      const truthDomain = extractDomain(groundTruthUrlNoQuery);
      
      if (lynxDomain && truthDomain && lynxDomain === truthDomain) {
        // Domains match exactly - this is an exact match
        return { type: 'exact_match', confidence: 1.0 };
      } else if (lynxDomain && truthDomain) {
        // Domain in extracted URL doesn't match ground truth - partial match
        return { type: 'partial_match', confidence: 0.85 };
      }
    } catch (e) {
      // If domain extraction fails, consider it an exact match since the regex matched
      return { type: 'exact_match', confidence: 0.95 };
    }
    
    // Default: if regex matches and we have a domain, it's exact
    return { type: 'exact_match', confidence: 0.95 };
    
  } catch (e) {
    return { type: 'no_match', confidence: 0.0 };
  }
}

// Helper function to calculate metrics
function calculateMetrics(detailedResults) {
  // Flatten all URL comparisons from nested structure
  const allComparisons = [];
  for (const result of detailedResults) {
    for (const comparison of result.urlComparisons) {
      allComparisons.push(comparison);
    }
  }
  
  // Count match types
  const counts = {
    exact_match: 0,
    partial_match: 0,
    no_match: 0,
    no_match_from_files_without_requests: 0,  // URLs from JS files that never executed
    missed_match: 0
  };
  
  // Count JS files with/without requests
  const jsFilesWithRequests = detailedResults.filter(r => r.hasRequests).length;
  const jsFilesWithoutRequests = detailedResults.filter(r => !r.hasRequests).length;
  
  // Count URLs from JS files with no requests (all false positives)
  const urlsFromNoRequestsFiles = detailedResults
    .filter(r => !r.hasRequests)
    .reduce((sum, r) => sum + r.lynxUrls.length, 0);
  
  let tp_strict = 0, tp_relaxed = 0, fp_strict = 0, fp_relaxed = 0, fn = 0;
  
  for (const comparison of allComparisons) {
    const type = comparison.match_type;
    
    // Separate no_match from files without requests
    if (type === 'no_match' && comparison.reason === 'JS_had_no_requests') {
      counts.no_match_from_files_without_requests++;
    } else {
      counts[type]++;
    }
    
    if (type === 'exact_match') {
      tp_strict += 1;
      tp_relaxed += 1;
    } else if (type === 'partial_match') {
      fp_strict += 1; // Strict: partial is false positive
      tp_relaxed += 1; // Relaxed: partial is true positive
    } else if (type === 'no_match' && comparison.reason !== 'JS_had_no_requests') {
      // Only count real no_match (not from files without requests) as false positives
      fp_strict += 1;
      fp_relaxed += 1;
    } else if (type === 'no_match' && comparison.reason === 'JS_had_no_requests') {
      // URLs from files without requests are also false positives for relaxed evaluation
      fp_relaxed += 1;
    } else if (type === 'missed_match') {
      fn += 1;
    }
  }
  
  // Calculate timing statistics
  const executionTimes = detailedResults
    .filter(r => r.lynxExecutionTimeMs !== undefined)
    .map(r => r.lynxExecutionTimeMs);
  
  const avgLynxTime = executionTimes.length > 0 
    ? executionTimes.reduce((a, b) => a + b, 0) / executionTimes.length 
    : 0;
  const maxLynxTime = executionTimes.length > 0 ? Math.max(...executionTimes) : 0;
  const minLynxTime = executionTimes.length > 0 ? Math.min(...executionTimes) : 0;
  const totalLynxTime = executionTimes.reduce((a, b) => a + b, 0);
  
  // Calculate metrics
  const precision_strict = tp_strict + fp_strict > 0 ? tp_strict / (tp_strict + fp_strict) : 0;
  const recall_strict = tp_strict + fn > 0 ? tp_strict / (tp_strict + fn) : 0;
  const f1_strict = precision_strict + recall_strict > 0 ? 2 * (precision_strict * recall_strict) / (precision_strict + recall_strict) : 0;
  
  const precision_relaxed = tp_relaxed + fp_relaxed > 0 ? tp_relaxed / (tp_relaxed + fp_relaxed) : 0;
  const recall_relaxed = tp_relaxed + fn > 0 ? tp_relaxed / (tp_relaxed + fn) : 0;
  const f1_relaxed = precision_relaxed + recall_relaxed > 0 ? 2 * (precision_relaxed * recall_relaxed) / (precision_relaxed + recall_relaxed) : 0;
  
  // Calculate Discovery Gain: how many additional URLs did Lynx find beyond dynamic?
  // Gain = no_match_real / total_ground_truth
  // Where no_match_real = no_match URLs from JS files that DID execute (not from files without requests)
  // This measures true discoveries from actively executing JS files
  const total_ground_truth = counts.exact_match + counts.partial_match + counts.missed_match;
  const no_match_real = counts.no_match;  // Only counts no_match from files that had requests
  
  // Flag: no ground truth means metrics are meaningless
  const has_ground_truth = total_ground_truth > 0;
  
  // When there's no ground truth, track how many URLs Lynx found instead
  const total_lynx_urls = counts.exact_match + counts.partial_match + counts.no_match;
  const lynx_urls_when_no_ground_truth = has_ground_truth ? 0 : total_lynx_urls;
  
  const discovery_gain = has_ground_truth ? no_match_real / total_ground_truth : 0;
  
  // Calculate completeness ratio: (exact + partial) / (exact + partial + no_match)
  // Measures what percentage of Lynx extractions align with dynamic behavior
  const total_lynx_extractions = counts.exact_match + counts.partial_match + counts.no_match;
  const completeness_ratio = total_lynx_extractions > 0 ? (counts.exact_match + counts.partial_match) / total_lynx_extractions : 0;
  
  return {
    strict: { tp: tp_strict, fp: fp_strict, fn: fn, precision: precision_strict, recall: recall_strict, f1: f1_strict },
    relaxed: { tp: tp_relaxed, fp: fp_relaxed, fn: fn, precision: precision_relaxed, recall: recall_relaxed, f1: f1_relaxed },
    counts: counts,
    has_ground_truth: has_ground_truth,
    lynx_urls_when_no_ground_truth: lynx_urls_when_no_ground_truth,
    discovery_gain: discovery_gain,
    completeness_ratio: completeness_ratio,
    timing: {
      totalLynxTimeMs: totalLynxTime,
      avgLynxTimeMs: avgLynxTime,
      minLynxTimeMs: minLynxTime,
      maxLynxTimeMs: maxLynxTime,
      filesAnalyzed: executionTimes.length
    },
    jsStatistics: {
      filesWithRequests: jsFilesWithRequests,
      filesWithoutRequests: jsFilesWithoutRequests,
      urlsFromFilesWithoutRequests: urlsFromNoRequestsFiles
    }
  };
}

// Helper function to format number to 4 decimal places
function formatNumber(num) {
  if (typeof num === 'string') return num; // Return 'N/A' as-is
  return Number.isInteger(num) ? num : num.toFixed(4);
}

// Helper function to process a single URL
async function processSingleUrl(url, outputPath = null) {
  let browser;
  try {
    // Step 1: Run Puppeteer crawler to generate ground truth
    browser = await puppeteer.launch();
    const page = await browser.newPage();
    let requests = [];
    let isDownloadDetected = false;

    // List of content-types that indicate a file download
    const downloadContentTypes = [
      'application/pdf',
      'application/zip',
      'application/x-zip-compressed',
      'application/x-rar-compressed',
      'application/x-7z-compressed',
      'application/gzip',
      'application/x-gzip',
      'application/x-tar',
      'application/octet-stream',
      'application/exe',
      'application/x-msdownload',
      'application/x-msdos-program',
      'video/',
      'audio/',
      'image/'
    ];

    // Enable request interception to capture initiator details
    await page.setRequestInterception(true);

    page.on('request', request => {
      requests.push({
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        initiator: request.initiator()
      });

      request.continue();
    });

    // Detect download responses and abort navigation
    page.on('response', response => {
      if (response.request().isNavigationRequest()) {
        const contentType = response.headers()['content-type'] || '';
        for (const downloadType of downloadContentTypes) {
          if (contentType.toLowerCase().includes(downloadType.toLowerCase())) {
            isDownloadDetected = true;
            console.log(`     ⚠️  Download detected (${contentType}). Aborting page load.`);
            page.goto('about:blank').catch(() => {}); // Abort by navigating away
            break;
          }
        }
      }
    });

    // Wait until no more active requests, but with fallback for downloads
    try {
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 10000 });
    } catch (navError) {
      if (isDownloadDetected) {
        // If download was detected, treat as a skip
        if (browser) {
          await browser.close();
        }
        return { metrics: null, detailedResults: [], requestCount: 0 };
      }
      throw navError;
    }
    
    await browser.close();
    browser = null;

    // Step 2: Extract all JavaScript files and their request counts
    // Build map of JS URLs -> requests they initiated
    const jsRequestMap = new Map(); // URL -> count of requests
    const jsInitiators = [];

    // First: Track all script-initiated requests
    requests.forEach((req, index) => {
      if (!req.initiator) return;

      // Type 2: Script initiators (JavaScript files loading resources dynamically)
      if (req.initiator.type === 'script' && req.initiator.stack && req.initiator.stack.callFrames && req.initiator.stack.callFrames.length > 0) {
        const topFrame = req.initiator.stack.callFrames[0];
        if (topFrame && topFrame.url && (topFrame.url.endsWith('.js') || topFrame.url.includes('.js?') || topFrame.url.includes('.js#'))) {
          if (!jsRequestMap.has(topFrame.url)) {
            jsRequestMap.set(topFrame.url, 0);
          }
          jsRequestMap.set(topFrame.url, jsRequestMap.get(topFrame.url) + 1);
          
          jsInitiators.push({
            index,
            url: topFrame.url,
            functionName: topFrame.functionName || 'anonymous',
            lineNumber: topFrame.lineNumber,
            columnNumber: topFrame.columnNumber,
            requestUrl: req.url,
            initiatorType: req.initiator.type,
            initiatorSource: 'script',
            callStack: req.initiator.stack.callFrames
          });
        }
      }
    });

    // Second: Collect all JS files that were directly loaded from HTML (even if they didn't initiate requests)
    // These are requests where req.url is a .js file and initiator is 'parser' (HTML)
    const parserJsFiles = new Set();
    requests.forEach((req, index) => {
      if (!req.initiator) return;

      // Type 1: JS files loaded by parser (HTML) - req.url is the JS file
      if (req.initiator.type === 'parser' && (req.url.endsWith('.js') || req.url.includes('.js?') || req.url.includes('.js#'))) {
        parserJsFiles.add(req.url);
        // Track request count (0 if not in jsRequestMap)
        if (!jsRequestMap.has(req.url)) {
          jsRequestMap.set(req.url, 0);
        }
      }
    });

    // Deduplicate jsInitiators by URL
    const uniqueInitiators = {};
    jsInitiators.forEach(initiator => {
      if (!uniqueInitiators[initiator.url]) {
        uniqueInitiators[initiator.url] = initiator;
      }
    });
    const deduplicatedInitiators = Object.values(uniqueInitiators);

    // If no JS files were found at all (neither parser-loaded nor script-initiated)
    if (parserJsFiles.size === 0 && jsRequestMap.size === 0) {
      const initiatorTypes = {};
      requests.forEach(req => {
        if (req.initiator) {
          initiatorTypes[req.initiator.type] = (initiatorTypes[req.initiator.type] || 0) + 1;
        }
      });
      
      const totalWithInitiators = Object.values(initiatorTypes).reduce((a, b) => a + b, 0);
      if (totalWithInitiators > 0) {
        console.log(`     📊 Initiator type distribution: ${JSON.stringify(initiatorTypes)}`);
      }
      
      return { metrics: null, detailedResults: [], requestCount: requests.length };
    }

    // Step 3: Run Lynx on each JavaScript initiator
    let lynxPath = process.env.LYNX_PATH || '/Users/dennisfeldbusch/TUD/LyN-X';
    let lynxCommand;
    try {
      execSync(`ls "${lynxPath}" > /dev/null 2>&1`);
      lynxCommand = path.join(lynxPath, 'lyn-x.js');
      if (!fs.existsSync(lynxCommand)) {
        throw new Error(`lyn-x.js not found at ${lynxCommand}`);
      }
    } catch (e) {
      return { metrics: null, detailedResults: [], requestCount: requests.length };
    }

    const tempDir = path.resolve('temp_js_files');
    const detailedResults = [];
    let filesSkipped = 0;
    let filesAnalyzed = 0;
    
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Collect all JS URLs to analyze: parser-loaded + script-initiated (deduplicated)
    const allJsUrls = new Set([
      ...parserJsFiles,
      ...jsRequestMap.keys()
    ]);

    // DEBUG: Log JS file collection statistics
    console.log(`     [DEBUG] Parser-loaded JS files found: ${parserJsFiles.size}`);
    console.log(`     [DEBUG] Script-initiated JS files found: ${Object.keys(uniqueInitiators).length}`);
    console.log(`     [DEBUG] Total unique JS URLs to analyze: ${allJsUrls.size}`);
    
    // Count JS files without requests
    let jsFilesWithoutRequestsIntended = 0;
    for (const jsUrl of allJsUrls) {
      const reqCount = jsRequestMap.get(jsUrl) || 0;
      if (reqCount === 0) {
        jsFilesWithoutRequestsIntended++;
      }
    }
    if (jsFilesWithoutRequestsIntended > 0) {
      console.log(`     [DEBUG] JS files with NO requests (intended for analysis): ${jsFilesWithoutRequestsIntended}`);
    }

    // Sequential processing - analyze each JS file one at a time
    for (const jsUrl of allJsUrls) {
      try {
        // Validate the JS URL
        if (!jsUrl || jsUrl.trim() === '') {
          continue;
        }

        // Skip non-JavaScript files
        if (!jsUrl.endsWith('.js') && !jsUrl.includes('.js?') && !jsUrl.includes('.js#')) {
          continue;
        }

        // Determine if this JS file had any requests
        const hasRequests = jsRequestMap.get(jsUrl) > 0;
        const requestCount = jsRequestMap.get(jsUrl) || 0;

        // Log progress
        const reqStatus = hasRequests ? '✓' : '✗ (no requests)';
        console.log(`     [Analyzing] ${jsUrl.substring(0, 80)}... [${reqStatus}]`);

        // Download the JavaScript file with timeout
        const fileName = generateSafeFilename(jsUrl, 0);
        const localFilePath = path.join(tempDir, fileName);
        
        try {
          await downloadFile(jsUrl, localFilePath, 10000);
        } catch (downloadError) {
          console.log(`     [Download ERROR] Failed to download: ${downloadError.message}`);
          continue;
        }

        // Run Lynx with the local file - MEASURE TIME
        let lynxOutput;
        let lynxExecutionTime = 0;
        let lynxStartTime_hr;
        try {
          // Extract domain from JS URL to pass as fallback to Lynx
          let domain = '';
          try {
            const urlObj = new URL(jsUrl);
            domain = `${urlObj.protocol}//${urlObj.host}`;
          } catch (e) {
            // If URL parsing fails, use empty domain
          }
          
          // Build Lynx command with optional domain parameter
          const domainParam = domain ? ` --domain "${domain}"` : '';
          const lynxCmd = `timeout 5 node "${lynxCommand}" "${localFilePath}"${domainParam} 2>&1`;
          
          lynxStartTime_hr = process.hrtime.bigint();
          lynxOutput = execSync(lynxCmd, { 
            encoding: 'utf-8',
            maxBuffer: 2 * 1024 * 1024,
            stdio: ['pipe', 'pipe', 'pipe']
          });
          const lynxEndTime_hr = process.hrtime.bigint();
          // Convert nanoseconds to milliseconds
          lynxExecutionTime = Number(lynxEndTime_hr - lynxStartTime_hr) / 1_000_000;
        } catch (lynxError) {
          if (lynxError.message && lynxError.message.includes('timeout')) {
            console.log(`     [Lynx TIMEOUT] Analysis took longer than 5 seconds`);
          } else {
            console.log(`     [Lynx ERROR] ${lynxError.message}`);
          }
          // Cleanup on error
          try {
            if (fs.existsSync(localFilePath)) {
              fs.unlinkSync(localFilePath);
            }
          } catch (e) {
            // Ignore cleanup errors
          }
          continue;
        }

        // Extract URLs from Lynx output
        const lynxUrls = extractUrlsFromLynxTable(lynxOutput);
        
        // Get all ground truth URLs initiated by this JS file (deduplicated)
        const groundTruthUrlsRaw = requests
          .filter(req => req.initiator && req.initiator.type === 'script' && req.initiator.stack)
          .filter(req => {
            const topFrame = req.initiator.stack.callFrames[0];
            return topFrame && topFrame.url === jsUrl;
          })
          .map(req => req.url);
        
        // Deduplicate ground truth URLs
        const groundTruthUrls = Array.from(new Set(groundTruthUrlsRaw));
        
        // Build many-to-many matches: each ground truth URL can match multiple Lynx URLs
        // and each Lynx URL can match multiple ground truth URLs
        const urlComparisons = [];
        const matchedLynxUrls = new Set(); // Track which Lynx URLs have been matched
        
        // If this JS file had NO requests but Lynx found URLs, these are all false positives
        if (!hasRequests && lynxUrls.length > 0) {
          // All Lynx URLs are unmatched false positives
          for (const lynxUrl of lynxUrls) {
            const lynxSegments = extractKnownSegments(lynxUrl);
            if (lynxSegments.length === 0) {
              continue;
            }
            urlComparisons.push({
              groundTruthUrl: null,
              lynxUrl: lynxUrl,
              match_type: 'no_match',
              confidence: 0.0,
              reason: 'JS_had_no_requests'
            });
          }
        } else if (hasRequests) {
          // Normal comparison flow for JS files that did have requests
          // First pass: For each ground truth URL, find all Lynx matches above confidence threshold
          for (const gtUrl of groundTruthUrls) {
            let bestMatch = { type: 'missed_match', confidence: 0.0, lynxUrl: null };
            
            for (const lynxUrl of lynxUrls) {
              // Skip Lynx URLs that are purely variables/calls with no real content
              const lynxSegments = extractKnownSegments(lynxUrl);
              if (lynxSegments.length === 0) {
                continue;
              }
              
              const match = classifyMatch(lynxUrl, gtUrl, looseMatchingFlag);
              if (match.confidence > bestMatch.confidence) {
                bestMatch = { ...match, lynxUrl: lynxUrl };
              }
            }
            
            urlComparisons.push({
              groundTruthUrl: gtUrl,
              lynxUrl: bestMatch.lynxUrl,
              match_type: bestMatch.type,
              confidence: bestMatch.confidence
            });
            
            if (bestMatch.lynxUrl) {
              matchedLynxUrls.add(bestMatch.lynxUrl);
            }
          }
          
          // Second pass: For each Lynx URL not yet matched, try to match against ground truth URLs
          for (const lynxUrl of lynxUrls) {
            const lynxSegments = extractKnownSegments(lynxUrl);
            if (lynxSegments.length === 0) {
              continue;
            }
            
            // If this Lynx URL was already primary-matched, skip it
            if (matchedLynxUrls.has(lynxUrl)) {
              continue;
            }
            
            let bestMatch = { type: 'no_match', confidence: 0.0, groundTruthUrl: null };
            
            for (const gtUrl of groundTruthUrls) {
              const match = classifyMatch(lynxUrl, gtUrl, looseMatchingFlag);
              if (match.confidence > bestMatch.confidence) {
                bestMatch = { ...match, groundTruthUrl: gtUrl };
              }
            }
            
            // Only add if we found a match above no_match threshold
            if (bestMatch.type !== 'no_match') {
              urlComparisons.push({
                groundTruthUrl: bestMatch.groundTruthUrl,
                lynxUrl: lynxUrl,
                match_type: bestMatch.type,
                confidence: bestMatch.confidence
              });
            } else {
              // True false positive: Lynx extracted something with no ground truth match
              urlComparisons.push({
                groundTruthUrl: null,
                lynxUrl: lynxUrl,
                match_type: 'no_match',
                confidence: 0.0
              });
            }
          }
        }
        
        // Store detailed results
        const hasExactMatch = urlComparisons.some(uc => uc.match_type === 'exact_match');
        const hasPartialMatch = urlComparisons.some(uc => uc.match_type === 'partial_match');
        
        // Cleanup temp file immediately to free memory
        try {
          if (fs.existsSync(localFilePath)) {
            fs.unlinkSync(localFilePath);
          }
        } catch (e) {
          // Ignore cleanup errors
        }

        detailedResults.push({
          initiatorUrl: jsUrl,
          initiatorType: parserJsFiles.has(jsUrl) ? 'parser' : 'script',
          groundTruthUrls: groundTruthUrls,
          lynxUrls: lynxUrls,
          urlComparisons: urlComparisons,
          hasExactMatch: hasExactMatch,
          hasPartialMatch: hasPartialMatch,
          lynxExecutionTimeMs: lynxExecutionTime,
          hasRequests: hasRequests,
          requestCount: requestCount
        });
        filesAnalyzed++;
      } catch (error) {
        filesSkipped++;
        continue;
      }
    }
    
    // Log analysis summary
    if (filesSkipped > 0) {
      console.log(`     [DEBUG] Files analyzed: ${filesAnalyzed}, Files skipped (errors): ${filesSkipped}`);
    }

    // Calculate metrics
    const metrics = calculateMetrics(detailedResults);
    
    // Cleanup
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    
    return { metrics, detailedResults, requestCount: requests.length };
  } catch (error) {
    if (browser) {
      await browser.close();
    }
    if (fs.existsSync('temp_js_files')) {
      fs.rmSync('temp_js_files', { recursive: true, force: true });
    }
    throw error;
  }
}

(async () => {
  try {
    if (!isBatchMode) {
      // Single URL mode - process one URL
      console.log(`\n🔍 Starting test with URL: ${targetUrl}\n`);
      
      console.log('📡 Running Puppeteer crawler...');
      const { metrics, detailedResults, requestCount } = await processSingleUrl(targetUrl);
      
      console.log(`✅ Crawler captured ${requestCount} requests`);
      console.log(`✅ Found ${detailedResults.length} unique JavaScript initiator(s)\n`);
      
      // Count JS files with and without requests
      const jsWithRequests = detailedResults.filter(r => r.hasRequests).length;
      const jsWithoutRequests = detailedResults.filter(r => !r.hasRequests).length;
      if (jsWithoutRequests > 0) {
        console.log(`⚠️  ${jsWithoutRequests} JS file(s) had NO requests but were analyzed by Lynx`);
      }
      console.log();
      
      if (metrics) {
        // Display JS File Statistics FIRST (important context)
        console.log('━'.repeat(60));
        console.log('\n📊 JAVASCRIPT FILE STATISTICS:\n');
        console.log(`  Total JS Files Analyzed:   ${metrics.jsStatistics.filesWithRequests + metrics.jsStatistics.filesWithoutRequests}`);
        console.log(`    • Files WITH requests:    ${metrics.jsStatistics.filesWithRequests}`);
        if (metrics.jsStatistics.filesWithoutRequests > 0) {
          console.log(`    • Files WITHOUT requests:  ${metrics.jsStatistics.filesWithoutRequests} ⚠️`);
          console.log(`\n  📌 IMPORTANT: ${metrics.jsStatistics.filesWithoutRequests} JS file(s) had NO requests during execution`);
          console.log(`     but Lynx extracted ${metrics.jsStatistics.urlsFromFilesWithoutRequests} URL(s) from them`);
        }
        
        // Display Results
        console.log('━'.repeat(60));
        console.log('\n📈 EVALUATION RESULTS\n');
        
        const counts = metrics.counts;
        console.log('Match Classification Summary:');
        console.log(`  • Exact Matches:   ${counts.exact_match}`);
        console.log(`  • Partial Matches: ${counts.partial_match}`);
        console.log(`  • No Matches:      ${counts.no_match}`);
        console.log(`  • Missed Matches:  ${counts.missed_match}`);
        console.log();
        
        console.log('━'.repeat(60));
        console.log('\n🔴 STRICT EVALUATION (Exact Match Only):\n');
        console.log(`  Precision: ${formatNumber(metrics.strict.precision)} | Recall: ${formatNumber(metrics.strict.recall)} | F1-Score: ${formatNumber(metrics.strict.f1)}`);
        console.log(`  (TP: ${metrics.strict.tp} | FP: ${metrics.strict.fp} | FN: ${metrics.strict.fn})\n`);
        
        console.log('🟡 RELAXED EVALUATION (Exact + Partial Matches):\n');
        console.log(`  Precision: ${formatNumber(metrics.relaxed.precision)} | Recall: ${formatNumber(metrics.relaxed.recall)} | F1-Score: ${formatNumber(metrics.relaxed.f1)}`);
        console.log(`  (TP: ${metrics.relaxed.tp} | FP: ${metrics.relaxed.fp} | FN: ${metrics.relaxed.fn})\n`);
        
        // Display Discovery Metrics
        console.log('━'.repeat(60));
        console.log('\n🔍 DISCOVERY METRICS:\n');
        console.log(`  Discovery Gain: ${formatNumber(metrics.discovery_gain)}`);
        console.log(`    → For every URL found by dynamic crawling, LyN-X found ${formatNumber(metrics.discovery_gain * 100)}% additional URLs\n`);
        console.log(`  Completeness:   ${formatNumber(metrics.completeness_ratio)}`);
        console.log(`    → ${formatNumber(metrics.completeness_ratio * 100)}% of LyN-X's extractions matched the dynamic behavior\n`);
        
        // Optional File Export
        if (outputFile) {
          console.log('━'.repeat(60));
          console.log('\n💾 Exporting Results...\n');
          
          const exportData = {
            metadata: {
              url: targetUrl,
              timestamp: new Date().toISOString(),
              totalInitiators: detailedResults.length
            },
            metrics: metrics,
            results: detailedResults
          };
          
          try {
            if (outputFile.endsWith('.json')) {
              fs.writeFileSync(outputFile, JSON.stringify(exportData, null, 2));
              console.log(`✅ JSON export saved: ${outputFile}\n`);
            } else if (outputFile.endsWith('.csv')) {
              const csvRows = ['initiatorUrl,initiatorType,groundTruthUrl,lynxUrl,matchType,confidence,lynxTimeMs,hasRequests,requestCount'];
              detailedResults.forEach(result => {
                const lynxTime = result.lynxExecutionTimeMs || 0;
                result.urlComparisons.forEach(uc => {
                  const row = [
                    `"${result.initiatorUrl}"`,
                    `"${result.initiatorType}"`,
                    `"${uc.groundTruthUrl || ''}"`,
                    `"${uc.lynxUrl || ''}"`,
                    uc.match_type,
                    formatNumber(uc.confidence),
                    lynxTime,
                    result.hasRequests ? 'yes' : 'no',
                    result.requestCount
                  ].join(',');
                  csvRows.push(row);
                });
              });
              fs.writeFileSync(outputFile, csvRows.join('\n'));
              console.log(`✅ CSV export saved: ${outputFile}\n`);
            }
          } catch (error) {
            console.log(`⚠️  Export failed: ${error.message}\n`);
          }
        }
      }
      
      process.exit(0);
    } else {
      // Batch mode - process multiple URLs
      const resultsDir = outputFile || 'results';
      
      // Create results directory if it doesn't exist
      if (!fs.existsSync(resultsDir)) {
        fs.mkdirSync(resultsDir, { recursive: true });
      }
      
      const resultsCsvPath = path.join(resultsDir, 'results.csv');
      const csvHeader = 'parent_domain,js_file_url,has_ground_truth,lynx_urls_when_no_ground_truth,strict_precision,strict_recall,strict_f1,relaxed_precision,relaxed_recall,relaxed_f1,discovery_gain,completeness_ratio,lynx_time_ms,has_requests,ground_truth_count,lynx_extraction_count';
      
      // Write header immediately
      fs.writeFileSync(resultsCsvPath, csvHeader + '\n');
      
      // Track all file-level results for calculating averages
      const allFileMetrics = [];
      const allDetailedResults = [];  // Accumulate detailed results across all URLs
      let totalJsFilesWithRequests = 0;
      let totalJsFilesWithoutRequests = 0;
      let totalUrlsFromFilesWithoutRequests = 0;
      let totalFilesProcessed = 0;
      
      for (let i = 0; i < urlList.length; i++) {
        const url = urlList[i];
        const urlIndex = i + 1;
        console.log(`\n[${urlIndex}/${urlList.length}] Processing: ${url}`);
        console.log('📡 Running Puppeteer crawler...');
        
        try {
          const { metrics, detailedResults, requestCount } = await processSingleUrl(url);
          
          // Accumulate detailed results from this URL
          allDetailedResults.push(...detailedResults);
          
          console.log(`✅ Crawler captured ${requestCount} requests`);
          if (detailedResults.length > 0) {
            console.log(`✅ Found ${detailedResults.length} unique JavaScript initiator(s)`);
            // Count JS files with and without requests
            const jsWithRequests = detailedResults.filter(r => r.hasRequests).length;
            const jsWithoutRequests = detailedResults.filter(r => !r.hasRequests).length;
            console.log(`   ├─ ${jsWithRequests} file(s) WITH requests`);
            if (jsWithoutRequests > 0) {
              const urlsFromNoReqFiles = detailedResults
                .filter(r => !r.hasRequests)
                .reduce((sum, r) => sum + r.lynxUrls.length, 0);
              console.log(`   └─ ${jsWithoutRequests} file(s) WITHOUT requests (Lynx found ${urlsFromNoReqFiles} URL(s) = False Positives) ⚠️`);
            }
          } else {
            console.log(`⚠️  No JavaScript initiators found`);
          }
          
          // Handle metrics and write one row per JS file analyzed
          if (metrics && detailedResults.length > 0) {
            // Collect JS file statistics
            if (metrics.jsStatistics) {
              totalJsFilesWithRequests += metrics.jsStatistics.filesWithRequests;
              totalJsFilesWithoutRequests += metrics.jsStatistics.filesWithoutRequests;
              totalUrlsFromFilesWithoutRequests += metrics.jsStatistics.urlsFromFilesWithoutRequests;
            }
            
            // Extract domain from URL for reporting
            let parentDomain = 'unknown';
            try {
              const urlObj = new URL(url);
              parentDomain = urlObj.hostname.replace(/^www\./, '');
            } catch (e) {
              // Keep default
            }
            
            // Write one row per JS file analyzed
            for (const fileResult of detailedResults) {
              try {
                // Calculate per-file metrics
                const fileComparisons = fileResult.urlComparisons;
                const groundTruthCount = fileResult.groundTruthUrls.length;
                const lynxExtractionCount = fileResult.lynxUrls.length;
                const hasGroundTruth = groundTruthCount > 0;
                
                // Count matches for this file
                let tpStrict = 0, tpRelaxed = 0, fpStrict = 0, fpRelaxed = 0, fn = 0;
                for (const comp of fileComparisons) {
                  const type = comp.match_type;
                  if (type === 'exact_match') {
                    tpStrict += 1;
                    tpRelaxed += 1;
                  } else if (type === 'partial_match') {
                    fpStrict += 1;
                    tpRelaxed += 1;
                  } else if (type === 'no_match' && comp.reason !== 'JS_had_no_requests') {
                    fpStrict += 1;
                    fpRelaxed += 1;
                  } else if (type === 'missed_match') {
                    fn += 1;
                  }
                }
                
                // Calculate per-file metrics
                const precisionStrict = tpStrict + fpStrict > 0 ? tpStrict / (tpStrict + fpStrict) : 0;
                const recallStrict = tpStrict + fn > 0 ? tpStrict / (tpStrict + fn) : 0;
                const f1Strict = precisionStrict + recallStrict > 0 ? 2 * (precisionStrict * recallStrict) / (precisionStrict + recallStrict) : 0;
                
                const precisionRelaxed = tpRelaxed + fpRelaxed > 0 ? tpRelaxed / (tpRelaxed + fpRelaxed) : 0;
                const recallRelaxed = tpRelaxed + fn > 0 ? tpRelaxed / (tpRelaxed + fn) : 0;
                const f1Relaxed = precisionRelaxed + recallRelaxed > 0 ? 2 * (precisionRelaxed * recallRelaxed) / (precisionRelaxed + recallRelaxed) : 0;
                
                const discoveryGain = groundTruthCount > 0 
                  ? fileComparisons.filter(c => c.match_type === 'no_match' && c.lynxUrl && c.lynxUrl.trim() !== '').length / groundTruthCount
                  : 0;
                
                const completenessRatio = lynxExtractionCount > 0
                  ? fileComparisons.filter(c => c.match_type === 'exact_match' || c.match_type === 'partial_match').length / lynxExtractionCount
                  : 0;
                
                // Prepare CSV row for this file
                const fileRow = [
                  `"${parentDomain}"`,
                  `"${fileResult.initiatorUrl}"`,
                  hasGroundTruth ? 1 : 0,
                  !hasGroundTruth ? lynxExtractionCount : 0,
                  hasGroundTruth ? formatNumber(precisionStrict) : 'N/A',
                  hasGroundTruth ? formatNumber(recallStrict) : 'N/A',
                  hasGroundTruth ? formatNumber(f1Strict) : 'N/A',
                  hasGroundTruth ? formatNumber(precisionRelaxed) : 'N/A',
                  hasGroundTruth ? formatNumber(recallRelaxed) : 'N/A',
                  hasGroundTruth ? formatNumber(f1Relaxed) : 'N/A',
                  hasGroundTruth ? formatNumber(discoveryGain) : 'N/A',
                  hasGroundTruth ? formatNumber(completenessRatio) : 'N/A',
                  formatNumber(fileResult.lynxExecutionTimeMs),
                  fileResult.hasRequests ? 1 : 0,
                  groundTruthCount,
                  lynxExtractionCount
                ].join(',');
                
                fs.appendFileSync(resultsCsvPath, fileRow + '\n');
                totalFilesProcessed++;
                
                // Store for average calculation if has ground truth
                if (hasGroundTruth) {
                  allFileMetrics.push({
                    parentDomain: parentDomain,
                    jsUrl: fileResult.initiatorUrl,
                    precisionStrict,
                    recallStrict,
                    f1Strict,
                    precisionRelaxed,
                    recallRelaxed,
                    f1Relaxed,
                    discoveryGain,
                    completenessRatio,
                    lynxTimeMs: fileResult.lynxExecutionTimeMs
                  });
                }
              } catch (fileError) {
                console.log(`  ⚠️  Error processing JS file metrics: ${fileError.message}`);
              }
            }
            
            console.log(`✅ ${detailedResults.length} file(s) written to results.csv`);
            
            // Create individual domain CSV
            const csvRows = ['initiatorUrl,initiatorType,groundTruthUrl,lynxUrl,matchType,confidence,lynxTimeMs'];
            const csvFileName = `url_${urlIndex}_${parentDomain}.csv`;
            const csvPath = path.join(resultsDir, csvFileName);

            detailedResults.forEach(result => {
              const lynxTime = result.lynxExecutionTimeMs || 0;
              result.urlComparisons.forEach(uc => {
                const row = [
                  `"${result.initiatorUrl}"`,
                  `"${result.initiatorType}"`,
                  `"${uc.groundTruthUrl || ''}"`,
                  `"${uc.lynxUrl || ''}"`,
                  uc.match_type,
                  formatNumber(uc.confidence),
                  lynxTime
                ].join(',');
                csvRows.push(row);
              });
            });
            fs.writeFileSync(csvPath, csvRows.join('\n'));
            console.log(`💾 Saved: ${csvFileName}`);
          } else {
            console.log(`⚠️  No metrics generated (no initiators)`);
          }
        } catch (error) {
          console.log(`❌ Error processing URL: ${error.message}`);
          
          // Append error row (16 columns: parent_domain, js_file_url, has_ground_truth, lynx_urls_when_no_ground_truth, metrics..., ground_truth_count, lynx_extraction_count)
          const errorRow = [
            `"${url}"`,  // parent_domain
            '""',        // js_file_url
            0,           // has_ground_truth
            0,           // lynx_urls_when_no_ground_truth
            'N/A',       // strict_precision
            'N/A',       // strict_recall
            'N/A',       // strict_f1
            'N/A',       // relaxed_precision
            'N/A',       // relaxed_recall
            'N/A',       // relaxed_f1
            'N/A',       // discovery_gain
            'N/A',       // completeness_ratio
            0,           // lynx_time_ms
            0,           // has_requests
            0,           // ground_truth_count
            0            // lynx_extraction_count
          ].join(',');
          fs.appendFileSync(resultsCsvPath, errorRow + '\n');
        }
      }
      
      // Calculate and append average row for files with ground truth
      if (allFileMetrics.length > 0) {
        console.log('\n' + '━'.repeat(60));
        console.log(`\n📊 Calculating averages from ${allFileMetrics.length} file(s) with ground truth...\n`);
        
        const fileCount = allFileMetrics.length;
        const avgRow = {
          parentDomain: 'AVERAGE',
          jsUrl: '(per-file metrics)',
          has_ground_truth: 1,
          lynx_urls_when_no_ground_truth: 0,
          strict_precision: allFileMetrics.reduce((sum, m) => sum + m.precisionStrict, 0) / fileCount,
          strict_recall: allFileMetrics.reduce((sum, m) => sum + m.recallStrict, 0) / fileCount,
          strict_f1: allFileMetrics.reduce((sum, m) => sum + m.f1Strict, 0) / fileCount,
          relaxed_precision: allFileMetrics.reduce((sum, m) => sum + m.precisionRelaxed, 0) / fileCount,
          relaxed_recall: allFileMetrics.reduce((sum, m) => sum + m.recallRelaxed, 0) / fileCount,
          relaxed_f1: allFileMetrics.reduce((sum, m) => sum + m.f1Relaxed, 0) / fileCount,
          discovery_gain: allFileMetrics.reduce((sum, m) => sum + m.discoveryGain, 0) / fileCount,
          completeness_ratio: allFileMetrics.reduce((sum, m) => sum + m.completenessRatio, 0) / fileCount,
          avgLynxTimeMs: allFileMetrics.reduce((sum, m) => sum + m.lynxTimeMs, 0) / fileCount
        };
        
        const avgResultRow = [
          `"${avgRow.parentDomain}"`,
          `"${avgRow.jsUrl}"`,
          avgRow.has_ground_truth,
          avgRow.lynx_urls_when_no_ground_truth,
          formatNumber(avgRow.strict_precision),
          formatNumber(avgRow.strict_recall),
          formatNumber(avgRow.strict_f1),
          formatNumber(avgRow.relaxed_precision),
          formatNumber(avgRow.relaxed_recall),
          formatNumber(avgRow.relaxed_f1),
          formatNumber(avgRow.discovery_gain),
          formatNumber(avgRow.completeness_ratio),
          formatNumber(avgRow.avgLynxTimeMs),
          1,           // has_requests (average row)
          0,           // ground_truth_count (N/A for average)
          0            // lynx_extraction_count (N/A for average)
        ].join(',');
        
        fs.appendFileSync(resultsCsvPath, avgResultRow + '\n');
        
        console.log('Average Metrics (across files with ground truth):');
        console.log(`  Strict:   Precision=${formatNumber(avgRow.strict_precision)}, Recall=${formatNumber(avgRow.strict_recall)}, F1=${formatNumber(avgRow.strict_f1)}`);
        console.log(`  Relaxed:  Precision=${formatNumber(avgRow.relaxed_precision)}, Recall=${formatNumber(avgRow.relaxed_recall)}, F1=${formatNumber(avgRow.relaxed_f1)}`);
        console.log(`  Discovery: Gain=${formatNumber(avgRow.discovery_gain)}, Completeness=${formatNumber(avgRow.completeness_ratio)}`);
        console.log(`  Timing:   Avg=${formatNumber(avgRow.avgLynxTimeMs)}ms across ${fileCount} files`);
          
          // Display overall JS file statistics
          console.log('\n📊 OVERALL JAVASCRIPT FILE STATISTICS:');
          const totalJsFiles = totalJsFilesWithRequests + totalJsFilesWithoutRequests;
          console.log(`  Total JS Files Analyzed: ${totalJsFiles}`);
          console.log(`    • Files WITH requests:    ${totalJsFilesWithRequests}`);
          if (totalJsFilesWithoutRequests > 0) {
            console.log(`    • Files WITHOUT requests:  ${totalJsFilesWithoutRequests} ⚠️`);
            console.log(`\n  📌 ${totalJsFilesWithoutRequests} JS file(s) had NO requests during execution`);
            console.log(`     but Lynx extracted ${totalUrlsFromFilesWithoutRequests} URL(s) from them`);
            console.log(`     → These ${totalUrlsFromFilesWithoutRequests} URL(s) are FALSE POSITIVES\n`);
          }
        
        // Report on files with no ground truth
        const filesNoGroundTruth = allDetailedResults.filter(f => f.groundTruthUrls.length === 0);
        if (filesNoGroundTruth.length > 0) {
          console.log('\n📌 FILES WITH NO DYNAMIC GROUND TRUTH:');
          console.log(`   (${filesNoGroundTruth.length} file(s) analyzed with 0 URLs from dynamic crawler)\n`);
          let totalLynxUrlsNoGT = 0;
          for (const file of filesNoGroundTruth) {
            console.log(`   • ${file.initiatorUrl}: Lynx found ${file.lynxUrls.length} URL(s)`);
            totalLynxUrlsNoGT += file.lynxUrls.length;
          }
          console.log(`\n   Total: Lynx found ${totalLynxUrlsNoGT} URL(s) when dynamic found nothing\n`);
        }
      } else {
        console.log('\n⚠️  No files with ground truth. AVERAGE row not calculated.\n');
      }
      
      console.log(`✅ Results saved: ${resultsCsvPath}\n`);
      
      process.exit(0);
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
})();
