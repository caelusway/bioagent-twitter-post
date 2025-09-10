require('dotenv').config();
const { Client } = require('pg');
const { TwitterApi } = require('twitter-api-v2');
const fs = require('fs');
const path = require('path');

class TwitterBot {
    constructor() {
        // Connection configuration
        this.mainDbConfig = {
            connectionString: process.env.POSTGRES_URL,
            ssl: false,
            connectionTimeoutMillis: 10000,
            idleTimeoutMillis: 30000,
            max: 1
        };
        
        this.railwayDbConfig = {
            connectionString: process.env.RAILWAY_POSTGRES_URL,
            ssl: { rejectUnauthorized: false },
            connectionTimeoutMillis: 10000,
            idleTimeoutMillis: 30000,
            max: 1
        };
        
        // Initialize clients
        this.pgClient = null;
        this.railwayClient = null;
        this.connectionStatus = {
            main: false,
            railway: false
        };
        
        // Twitter client
        this.twitterClient = new TwitterApi({
            appKey: process.env.TWITTER_API_KEY,
            appSecret: process.env.TWITTER_API_SECRET_KEY,
            accessToken: process.env.TWITTER_ACCESS_TOKEN,
            accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
        });
        
        this.rwClient = this.twitterClient.readWrite;
        // Start from a past date to catch existing records, then update to current time
        this.lastCheckTime = new Date(Date.now() - 12 * 60 * 60 * 1000); // 12 hours ago
        this.processedIds = new Set();
        this.isRunning = false;
        
        // Logging setup
        this.logsDir = path.join(__dirname, 'logs');
        this.ensureLogsDirectory();
        
        // Statistics
        this.stats = {
            totalProcessed: 0,
            successfulPosts: 0,
            failedPosts: 0,
            skippedRecords: 0,
            errors: 0,
            startTime: new Date(),
            rateLimitHits: 0,
            totalWaitTime: 0
        };
        
        // Rate limiting tracking
        this.rateLimits = {
            tweets: {
                remaining: null,
                resetTime: null,
                limit: null,
                lastCheck: null
            },
            lookup: {
                remaining: null,
                resetTime: null,
                limit: null,
                lastCheck: null
            }
        };
        
        // Rate limiting configuration
        this.config = {
            minDelayBetweenPosts: 2000, // 2 seconds minimum between posts
            maxDelayBetweenPosts: 30000, // 30 seconds max backoff
            rateLimitBackoffMultiplier: 2,
            maxRetries: 3,
            retryDelayMs: 5000 // 5 seconds between retries
        };
        
        this.log('INFO', 'Bot initialized', { stats: this.stats });
    }

    ensureLogsDirectory() {
        if (!fs.existsSync(this.logsDir)) {
            fs.mkdirSync(this.logsDir, { recursive: true });
        }
    }

    log(level, message, data = {}) {
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            level,
            message,
            data,
            sessionId: this.stats.startTime.getTime()
        };
        
        // Console output with colors
        const colors = {
            ERROR: '\x1b[31m',
            WARN: '\x1b[33m', 
            INFO: '\x1b[36m',
            SUCCESS: '\x1b[32m',
            DEBUG: '\x1b[90m',
            RESET: '\x1b[0m'
        };
        
        const color = colors[level] || colors.INFO;
        console.log(`${color}[${timestamp}] ${level}: ${message}${colors.RESET}`);
        
        if (data && Object.keys(data).length > 0) {
            console.log(`${color}${JSON.stringify(data, null, 2)}${colors.RESET}`);
        }
        
        // Write to daily log file
        const dateStr = timestamp.split('T')[0];
        const logFile = path.join(this.logsDir, `bot-${dateStr}.log`);
        const logLine = JSON.stringify(logEntry) + '\n';
        
        try {
            fs.appendFileSync(logFile, logLine);
        } catch (error) {
            console.error('Failed to write to log file:', error.message);
        }
        
        // Write to error log if it's an error
        if (level === 'ERROR') {
            const errorLogFile = path.join(this.logsDir, 'errors.log');
            try {
                fs.appendFileSync(errorLogFile, logLine);
            } catch (error) {
                console.error('Failed to write to error log file:', error.message);
            }
        }
        
        // Write to activity summary
        this.updateActivitySummary(logEntry);
    }

    updateActivitySummary(logEntry) {
        const summaryFile = path.join(this.logsDir, 'activity_summary.json');
        
        try {
            let summary = {};
            if (fs.existsSync(summaryFile)) {
                summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
            }
            
            const dateStr = logEntry.timestamp.split('T')[0];
            if (!summary[dateStr]) {
                summary[dateStr] = {
                    totalLogs: 0,
                    errors: 0,
                    warnings: 0,
                    successes: 0,
                    activities: []
                };
            }
            
            summary[dateStr].totalLogs++;
            if (logEntry.level === 'ERROR') summary[dateStr].errors++;
            if (logEntry.level === 'WARN') summary[dateStr].warnings++;
            if (logEntry.level === 'SUCCESS') summary[dateStr].successes++;
            
            // Keep only last 10 activities per day
            summary[dateStr].activities.unshift({
                time: logEntry.timestamp.split('T')[1].split('.')[0],
                level: logEntry.level,
                message: logEntry.message
            });
            summary[dateStr].activities = summary[dateStr].activities.slice(0, 10);
            
            fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
        } catch (error) {
            console.error('Failed to update activity summary:', error.message);
        }
    }

    // Rate limiting helper methods
    updateRateLimitInfo(endpoint, headers) {
        if (!headers) return;
        
        const rateLimit = this.rateLimits[endpoint];
        if (!rateLimit) return;
        
        // Extract rate limit headers
        const remaining = headers['x-rate-limit-remaining'];
        const resetTime = headers['x-rate-limit-reset'];
        const limit = headers['x-rate-limit-limit'];
        
        if (remaining !== undefined) rateLimit.remaining = parseInt(remaining);
        if (resetTime !== undefined) rateLimit.resetTime = parseInt(resetTime) * 1000; // Convert to milliseconds
        if (limit !== undefined) rateLimit.limit = parseInt(limit);
        rateLimit.lastCheck = Date.now();
        
        this.log('DEBUG', `Updated rate limit info for ${endpoint}`, {
            remaining: rateLimit.remaining,
            limit: rateLimit.limit,
            resetIn: rateLimit.resetTime ? Math.max(0, rateLimit.resetTime - Date.now()) / 1000 : 'unknown',
            resetTime: rateLimit.resetTime ? new Date(rateLimit.resetTime).toISOString() : 'unknown'
        });
    }
    
    async checkRateLimit(endpoint) {
        const rateLimit = this.rateLimits[endpoint];
        if (!rateLimit || !rateLimit.remaining || !rateLimit.resetTime) {
            return { canProceed: true, waitTime: 0 };
        }
        
        const now = Date.now();
        
        // If rate limit has reset, we're good to go
        if (now >= rateLimit.resetTime) {
            rateLimit.remaining = rateLimit.limit;
            return { canProceed: true, waitTime: 0 };
        }
        
        // If we have remaining requests, proceed
        if (rateLimit.remaining > 0) {
            return { canProceed: true, waitTime: 0 };
        }
        
        // Rate limited - calculate wait time
        const waitTime = rateLimit.resetTime - now;
        this.log('WARN', `Rate limit hit for ${endpoint}`, {
            remaining: rateLimit.remaining,
            limit: rateLimit.limit,
            waitTimeSeconds: Math.ceil(waitTime / 1000),
            resetTime: new Date(rateLimit.resetTime).toISOString()
        });
        
        return { canProceed: false, waitTime };
    }
    
    async waitForRateLimit(waitTime) {
        if (waitTime <= 0) return;
        
        const waitSeconds = Math.ceil(waitTime / 1000);
        this.log('INFO', `Waiting for rate limit reset`, {
            waitTimeSeconds: waitSeconds,
            resumeTime: new Date(Date.now() + waitTime).toISOString()
        });
        
        this.stats.rateLimitHits++;
        this.stats.totalWaitTime += waitTime;
        
        // Wait in chunks to allow for graceful shutdown
        const chunkSize = 5000; // 5 second chunks
        let remainingWait = waitTime;
        
        while (remainingWait > 0 && this.isRunning) {
            const currentWait = Math.min(chunkSize, remainingWait);
            await new Promise(resolve => setTimeout(resolve, currentWait));
            remainingWait -= currentWait;
            
            if (remainingWait > 0) {
                this.log('DEBUG', `Still waiting for rate limit reset`, {
                    remainingSeconds: Math.ceil(remainingWait / 1000)
                });
            }
        }
        
        if (this.isRunning) {
            this.log('INFO', 'Rate limit wait completed, resuming operations');
        }
    }
    
    async rateLimitedDelay() {
        // Apply minimum delay between posts
        const delay = this.config.minDelayBetweenPosts;
        if (delay > 0) {
            this.log('DEBUG', `Applying rate limit delay`, { delayMs: delay });
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    async createDatabaseConnection(config, name) {
        const client = new Client(config);
        
        // Add error handlers
        client.on('error', (err) => {
            this.log('ERROR', `Database connection error (${name})`, {
                error: err.message,
                code: err.code
            });
            this.connectionStatus[name.toLowerCase()] = false;
        });
        
        client.on('end', () => {
            this.log('WARN', `Database connection ended (${name})`);
            this.connectionStatus[name.toLowerCase()] = false;
        });
        
        return client;
    }

    async ensureConnection(client, config, name) {
        if (!client || client._ending || !this.connectionStatus[name.toLowerCase()]) {
            this.log('INFO', `Reconnecting to ${name} database...`);
            
            try {
                if (client && !client._ending) {
                    await client.end();
                }
            } catch (err) {
                // Ignore errors when closing
            }
            
            const newClient = await this.createDatabaseConnection(config, name);
            await newClient.connect();
            this.connectionStatus[name.toLowerCase()] = true;
            this.log('SUCCESS', `Reconnected to ${name} database`);
            
            return newClient;
        }
        
        return client;
    }

    async executeQuery(client, config, name, query, params = []) {
        let attempts = 0;
        const maxAttempts = 3;
        
        while (attempts < maxAttempts) {
            try {
                client = await this.ensureConnection(client, config, name);
                const result = await client.query(query, params);
                return { client, result };
            } catch (error) {
                attempts++;
                this.log('WARN', `Query attempt ${attempts} failed (${name})`, {
                    error: error.message,
                    code: error.code
                });
                
                if (attempts >= maxAttempts) {
                    throw error;
                }
                
                // Wait before retry
                await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
                this.connectionStatus[name.toLowerCase()] = false;
            }
        }
    }

    async connect() {
        try {
            // Connect to main database for twitter_answers polling
            this.pgClient = await this.createDatabaseConnection(this.mainDbConfig, 'Main');
            await this.pgClient.connect();
            this.connectionStatus.main = true;
            this.log('SUCCESS', 'Connected to main PostgreSQL database (twitter_answers)');
            
            // Connect to Railway database for processed_records storage
            this.railwayClient = await this.createDatabaseConnection(this.railwayDbConfig, 'Railway');
            await this.railwayClient.connect();
            this.connectionStatus.railway = true;
            this.log('SUCCESS', 'Connected to Railway PostgreSQL database (processed_records)');
            
            // Create processed_records table in Railway database if it doesn't exist
            await this.createProcessedRecordsTable();
            
            // Load previously processed IDs from Railway database
            await this.loadProcessedIds();
            
            // Test Twitter connection
            const me = await this.rwClient.v2.me();
            this.log('SUCCESS', `Twitter connected as @${me.data.username}`, { userId: me.data.id });
            
            return true;
        } catch (error) {
            this.log('ERROR', 'Connection failed', { error: error.message, stack: error.stack });
            this.stats.errors++;
            return false;
        }
    }

    async createProcessedRecordsTable() {
        try {
            const createTableQuery = `
                CREATE TABLE IF NOT EXISTS processed_records (
                    record_id VARCHAR(255) PRIMARY KEY,
                    processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    posted_tweet_id VARCHAR(255),
                    reply_to_tweet_id VARCHAR(255),
                    status VARCHAR(50) DEFAULT 'success',
                    content_length INTEGER,
                    poi_transaction TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `;
            
            await this.railwayClient.query(createTableQuery);
            
            // Add index for better query performance
            await this.railwayClient.query(`
                CREATE INDEX IF NOT EXISTS idx_processed_records_processed_at 
                ON processed_records(processed_at)
            `);
            
            await this.railwayClient.query(`
                CREATE INDEX IF NOT EXISTS idx_processed_records_status 
                ON processed_records(status)
            `);
            
            this.log('SUCCESS', 'Processed records table ready with enhanced schema');
        } catch (error) {
            this.log('ERROR', 'Failed to create processed_records table', { error: error.message });
            throw error;
        }
    }

    async loadProcessedIds() {
        try {
            const query = 'SELECT record_id FROM processed_records';
            const { client, result } = await this.executeQuery(
                this.railwayClient, 
                this.railwayDbConfig, 
                'Railway', 
                query
            );
            this.railwayClient = client;
            
            this.processedIds = new Set(result.rows.map(row => row.record_id));
            this.log('INFO', `Loaded ${this.processedIds.size} previously processed IDs from Railway database`);
        } catch (error) {
            this.log('INFO', 'No previous processed IDs found or error loading', { error: error.message });
            this.processedIds = new Set();
        }
    }

    async saveProcessedId(recordId, postedTweetId = null, replyToTweetId = null, status = 'success', contentLength = null, poiTransaction = null) {
        try {
            const query = `
                INSERT INTO processed_records (
                    record_id, 
                    posted_tweet_id, 
                    reply_to_tweet_id, 
                    status,
                    content_length,
                    poi_transaction,
                    processed_at,
                    updated_at
                ) 
                VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW()) 
                ON CONFLICT (record_id) DO UPDATE SET
                    posted_tweet_id = EXCLUDED.posted_tweet_id,
                    status = EXCLUDED.status,
                    updated_at = NOW()
            `;
            
            const { client } = await this.executeQuery(
                this.railwayClient,
                this.railwayDbConfig,
                'Railway',
                query,
                [recordId, postedTweetId, replyToTweetId, status, contentLength, poiTransaction]
            );
            this.railwayClient = client;
            
            this.processedIds.add(recordId);
            
            this.log('DEBUG', `Saved processed record to database`, { 
                recordId, 
                postedTweetId, 
                replyToTweetId,
                status,
                contentLength 
            });
        } catch (error) {
            this.log('ERROR', 'Failed to save processed record to database', { 
                error: error.message, 
                recordId 
            });
            this.stats.errors++;
        }
    }

    // Keep legacy method for compatibility but make it call the new method
    async saveProcessedIds() {
        this.log('DEBUG', 'saveProcessedIds called (legacy method) - using database storage');
    }

    isValidRecord(record) {
        // Must have poi_transaction
        //if (!record.poi_transaction || record.poi_transaction === null) {
          //  return false;
        //}
        
        // Must have answer
        if (!record.answer || record.answer.trim().length === 0) {
            return false;
        }
        
        // Must have tweet_id to reply to
        if (!record.tweet_id || record.tweet_id.trim().length === 0) {
            return false;
        }
        
        // Records can contain scientific papers - we'll clean them before posting
        return true;
    }

    cleanAnswerForTwitter(answer) {
        // Strategy: Keep everything EXCEPT "Science papers:" section
        const lines = answer.split('\n');
        const cleanedLines = [];
        let skipMode = false;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            
            // Start skipping only at "Science papers:" section  
            if (trimmed.toLowerCase().includes('science papers:')) {
                skipMode = true;
                continue;
            }
            
            // If in skip mode, check if we're still in science papers section
            if (skipMode) {
                // Stop skipping if we hit an empty line followed by non-paper content
                if (trimmed === '') {
                    // Look ahead to see if next non-empty line is still a paper reference
                    let nextContentIndex = i + 1;
                    while (nextContentIndex < lines.length && lines[nextContentIndex].trim() === '') {
                        nextContentIndex++;
                    }
                    
                    if (nextContentIndex < lines.length) {
                        const nextLine = lines[nextContentIndex].trim();
                        // If next line doesn't look like a paper reference, stop skipping
                        if (!nextLine.match(/^[A-Z][a-z]+.*\d{4}\.\d{2}\.\d{2}/) && 
                            !nextLine.includes('10.') &&
                            !nextLine.match(/^[A-Z\s]+ \d/)) {
                            skipMode = false;
                        }
                    }
                }
                
                // Skip this line if we're still in science papers mode
                if (skipMode) continue;
            }
            
            // Keep all other content (including Molecule Proof of Invention)
            cleanedLines.push(line);
        }
        
        return cleanedLines.join('\n').trim();
    }

    async getNewRecords() {
        try {
            // Use UTC for timezone consistency
            const utcLastCheckTime = this.lastCheckTime.toISOString();
            
            const query = `
                SELECT * FROM twitter_answers 
                WHERE created_at > $1::timestamp
                ORDER BY created_at DESC
                LIMIT 50
            `;
            
            this.log('DEBUG', 'Executing database query', {
                lastCheckTime: utcLastCheckTime,
                localTime: this.lastCheckTime.toLocaleString(),
                query: query.trim()
            });
            
            const { client, result } = await this.executeQuery(
                this.pgClient,
                this.mainDbConfig,
                'Main',
                query,
                [utcLastCheckTime]
            );
            this.pgClient = client;
            
            // Filter valid records that haven't been processed
            const newRecords = result.rows.filter(record => 
                this.isValidRecord(record) && !this.processedIds.has(record.id)
            );
            
            this.log('INFO', 'Database query completed', {
                totalFound: result.rows.length,
                validForPosting: newRecords.length,
                lastCheckTime: utcLastCheckTime,
                sampleRecordDates: result.rows.slice(0, 3).map(r => ({
                    id: r.id,
                    created_at: r.created_at,
                    has_poi: !!r.poi_transaction,
                    has_tweet_id: !!r.tweet_id
                }))
            });
            
            return newRecords;
            
        } catch (error) {
            this.log('ERROR', 'Error getting new records from database', {
                error: error.message,
                stack: error.stack,
                lastCheckTime: this.lastCheckTime.toISOString()
            });
            this.stats.errors++;
            return [];
        }
    }

    async validateTweet(tweetId) {
        try {
            // Check rate limit before making API call
            const rateLimitCheck = await this.checkRateLimit('lookup');
            if (!rateLimitCheck.canProceed) {
                await this.waitForRateLimit(rateLimitCheck.waitTime);
            }
            
            // Try to get the tweet to verify it exists and is accessible
            const response = await this.rwClient.v2.singleTweet(tweetId);
            
            // Update rate limit info from response headers
            this.updateRateLimitInfo('lookup', response.headers);
            
            return true;
        } catch (error) {
            // Update rate limit info even on error
            if (error.headers) {
                this.updateRateLimitInfo('lookup', error.headers);
            }
            
            // Check if this is a rate limit error
            if (error.code === 429 || (error.data && error.data.title === 'Too Many Requests')) {
                this.log('WARN', 'Rate limit hit during tweet validation', {
                    tweetId: tweetId,
                    error: error.message
                });
                
                // Extract wait time from rate limit headers
                const resetTime = error.headers && error.headers['x-rate-limit-reset'];
                if (resetTime) {
                    const waitTime = (parseInt(resetTime) * 1000) - Date.now();
                    if (waitTime > 0) {
                        await this.waitForRateLimit(waitTime);
                        // Retry once after waiting
                        return await this.validateTweet(tweetId);
                    }
                }
            }
            
            this.log('WARN', 'Tweet validation failed', {
                tweetId: tweetId,
                error: error.message,
                reason: 'Tweet may be deleted, private, or from suspended account'
            });
            return false;
        }
    }

    async postToTwitter(record, retryCount = 0) {
        try {
            const replyToTweetId = record.tweet_id;
            
            // First, validate that the tweet exists
            this.log('DEBUG', 'Validating original tweet exists', { tweetId: replyToTweetId });
            const tweetExists = await this.validateTweet(replyToTweetId);
            
            if (!tweetExists) {
                this.log('WARN', 'Original tweet not accessible - SKIPPING', {
                    recordId: record.id,
                    tweetId: replyToTweetId
                });
                this.stats.skippedRecords++;
                // Mark as processed so we don't try again
                await this.saveProcessedId(record.id, null, replyToTweetId, 'skipped_tweet_not_accessible', null, record.poi_transaction);
                return null;
            }
            
            // Clean the answer by removing scientific paper references
            const cleanedContent = this.cleanAnswerForTwitter(record.answer);
            
            if (!cleanedContent || cleanedContent.trim().length === 0) {
                this.log('WARN', 'No content left after cleaning scientific papers - SKIPPING', {
                    recordId: record.id,
                    originalLength: record.answer.length
                });
                this.stats.skippedRecords++;
                return null;
            }
            
            let finalContent = cleanedContent.trim();
            
            // With blue checkmark, we have much higher limits (up to 25,000 chars)
            // Only truncate if extremely long (over 20,000 chars as safety)
            if (finalContent.length > 20000) {
                console.log(`⚠️  Tweet extremely long (${finalContent.length} chars), truncating...`);
                finalContent = finalContent.substring(0, 19995) + '...';
            } else {
                console.log(`📏 Tweet length: ${finalContent.length} chars (within limits)`);
            }
            
            // Check rate limit before posting
            const rateLimitCheck = await this.checkRateLimit('tweets');
            if (!rateLimitCheck.canProceed) {
                await this.waitForRateLimit(rateLimitCheck.waitTime);
            }
            
            // Create tweet options - ALWAYS as reply
            const tweetOptions = {
                text: finalContent,
                reply: {
                    in_reply_to_tweet_id: replyToTweetId
                }
            };
            
            this.log('INFO', 'Attempting to post reply', {
                recordId: record.id,
                replyToTweetId: replyToTweetId,
                contentPreview: finalContent.substring(0, 100),
                contentLength: finalContent.length,
                retryCount: retryCount
            });
            
            const tweet = await this.rwClient.v2.tweet(tweetOptions);
            
            // Update rate limit info from response headers
            this.updateRateLimitInfo('tweets', tweet.headers);
            
            this.log('SUCCESS', 'Successfully posted reply', {
                recordId: record.id,
                tweetId: tweet.data.id,
                replyToTweetId: replyToTweetId,
                url: `https://twitter.com/Aubrai_/status/${tweet.data.id}`,
                retryCount: retryCount
            });
            
            this.stats.successfulPosts++;
            return {
                tweetId: tweet.data.id,
                contentLength: finalContent.length
            };
            
        } catch (error) {
            // Update rate limit info even on error
            if (error.headers) {
                this.updateRateLimitInfo('tweets', error.headers);
            }
            
            // Handle rate limit errors with backoff and retry
            if (error.code === 429 || (error.data && error.data.title === 'Too Many Requests')) {
                this.log('WARN', 'Rate limit hit during tweet posting', {
                    recordId: record.id,
                    retryCount: retryCount,
                    error: error.message
                });
                
                if (retryCount < this.config.maxRetries) {
                    // Calculate exponential backoff delay
                    const baseDelay = this.config.retryDelayMs;
                    const backoffDelay = baseDelay * Math.pow(this.config.rateLimitBackoffMultiplier, retryCount);
                    const finalDelay = Math.min(backoffDelay, this.config.maxDelayBetweenPosts);
                    
                    this.log('INFO', 'Retrying after rate limit backoff', {
                        recordId: record.id,
                        retryCount: retryCount + 1,
                        delayMs: finalDelay
                    });
                    
                    // Wait for backoff delay
                    await new Promise(resolve => setTimeout(resolve, finalDelay));
                    
                    // Retry the post
                    return await this.postToTwitter(record, retryCount + 1);
                } else {
                    this.log('ERROR', 'Max retries reached for rate limited tweet', {
                        recordId: record.id,
                        maxRetries: this.config.maxRetries
                    });
                }
            }
            
            this.log('ERROR', 'Failed to post reply', {
                recordId: record.id,
                replyToTweetId: record.tweet_id,
                error: error.message,
                errorCode: error.code,
                errorData: error.data,
                retryCount: retryCount,
                stack: error.stack
            });
            
            this.stats.failedPosts++;
            this.stats.errors++;
            
            // Check for deleted/not visible tweet errors
            if (error.message.includes('replied-to') || 
                error.message.includes('not found') ||
                error.message.includes('deleted') ||
                error.message.includes('not visible to you') ||
                (error.data && error.data.detail && error.data.detail.includes('deleted or not visible'))) {
                
                this.log('WARN', 'Original tweet deleted/not visible - SKIPPING', { 
                    recordId: record.id,
                    tweetId: record.tweet_id,
                    reason: 'Tweet deleted or not visible'
                });
                this.stats.skippedRecords++;
                
                // Mark as processed so we don't try again
                await this.saveProcessedId(record.id, null, record.tweet_id, 'skipped_tweet_deleted', null, record.poi_transaction);
                
            } else {
                this.log('ERROR', 'Reply failed for unknown reason', {
                    recordId: record.id,
                    errorDetails: error,
                    fullError: JSON.stringify(error, null, 2)
                });
            }
            
            return null;
        }
    }

    async processNewRecords() {
        const records = await this.getNewRecords();
        
        if (records.length === 0) {
            this.log('INFO', 'No new records to process');
            return;
        }
        
        this.log('INFO', `Starting to process ${records.length} new records`);
        
        for (const record of records) {
            this.stats.totalProcessed++;
            
            this.log('INFO', `Processing record ${this.stats.totalProcessed}/${records.length}`, {
                recordId: record.id,
                createdAt: record.created_at,
                poiTransaction: record.poi_transaction,
                answerPreview: record.answer.substring(0, 100)
            });
            
            // Post to Twitter
            const tweetResult = await this.postToTwitter(record);
            
            if (tweetResult && tweetResult.tweetId) {
                // Mark as processed and save to database
                await this.saveProcessedId(record.id, tweetResult.tweetId, record.tweet_id, 'success', tweetResult.contentLength, record.poi_transaction);
                this.log('SUCCESS', `Successfully processed record`, {
                    recordId: record.id,
                    tweetId: tweetResult.tweetId
                });
                
                // Apply rate-limited delay between posts
                await this.rateLimitedDelay();
            } else {
                this.log('ERROR', `Failed to process record`, {
                    recordId: record.id
                });
            }
        }
        
        // Update last check time to current UTC time
        const newCheckTime = new Date();
        this.log('DEBUG', 'Updating lastCheckTime', {
            previousTime: this.lastCheckTime.toISOString(),
            newTime: newCheckTime.toISOString(),
            recordsProcessed: records.length
        });
        
        this.lastCheckTime = newCheckTime;
        this.logCurrentStats();
    }

    logCurrentStats() {
        const uptime = Date.now() - this.stats.startTime.getTime();
        const uptimeHours = Math.floor(uptime / (1000 * 60 * 60));
        const uptimeMinutes = Math.floor((uptime % (1000 * 60 * 60)) / (1000 * 60));
        
        // Rate limit status
        const rateLimitStatus = {
            tweets: {
                remaining: this.rateLimits.tweets.remaining,
                limit: this.rateLimits.tweets.limit,
                resetIn: this.rateLimits.tweets.resetTime ? 
                    Math.max(0, Math.ceil((this.rateLimits.tweets.resetTime - Date.now()) / 1000)) : 'unknown'
            },
            lookup: {
                remaining: this.rateLimits.lookup.remaining,
                limit: this.rateLimits.lookup.limit,
                resetIn: this.rateLimits.lookup.resetTime ? 
                    Math.max(0, Math.ceil((this.rateLimits.lookup.resetTime - Date.now()) / 1000)) : 'unknown'
            }
        };
        
        this.log('INFO', 'Current session statistics', {
            uptime: `${uptimeHours}h ${uptimeMinutes}m`,
            totalProcessed: this.stats.totalProcessed,
            successfulPosts: this.stats.successfulPosts,
            failedPosts: this.stats.failedPosts,
            skippedRecords: this.stats.skippedRecords,
            errors: this.stats.errors,
            rateLimitHits: this.stats.rateLimitHits,
            totalWaitTimeMin: Math.round(this.stats.totalWaitTime / (1000 * 60)),
            successRate: this.stats.totalProcessed > 0 ? 
                ((this.stats.successfulPosts / this.stats.totalProcessed) * 100).toFixed(1) + '%' : '0%',
            rateLimits: rateLimitStatus
        });
    }

    async start() {
        console.log('🤖 Twitter Bot - Database Polling');
        console.log('==================================');
        
        const connected = await this.connect();
        if (!connected) {
            process.exit(1);
        }
        
        this.isRunning = true;
        
        console.log(`📡 Starting polling every 60 seconds...`);
        console.log(`🕐 Started at: ${new Date().toISOString()}`);
        console.log(`🔴 Press Ctrl+C to stop\n`);
        
        // Initial check
        await this.processNewRecords();
        
        // Set up interval
        const interval = setInterval(async () => {
            if (!this.isRunning) {
                clearInterval(interval);
                return;
            }
            
            console.log(`\n⏰ Checking for new records at ${new Date().toISOString()}`);
            await this.processNewRecords();
            
        }, 60000); // 60 seconds
        
        // Global error handlers
        process.on('uncaughtException', (error) => {
            this.log('ERROR', 'Uncaught Exception', {
                error: error.message,
                stack: error.stack
            });
            console.error('💥 Uncaught Exception:', error);
        });
        
        process.on('unhandledRejection', (reason, promise) => {
            this.log('ERROR', 'Unhandled Promise Rejection', {
                reason: reason instanceof Error ? reason.message : reason,
                stack: reason instanceof Error ? reason.stack : undefined
            });
            console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
        });
        
        // Graceful shutdown
        process.on('SIGINT', async () => {
            console.log('\n\n🛑 Shutting down...');
            this.isRunning = false;
            clearInterval(interval);
            
            try {
                await this.pgClient.end();
                console.log('✅ Main database connection closed');
            } catch (error) {
                console.error('❌ Error closing main database:', error.message);
            }
            
            try {
                await this.railwayClient.end();
                console.log('✅ Railway database connection closed');
            } catch (error) {
                console.error('❌ Error closing Railway database:', error.message);
            }
            
            console.log(`📊 Total processed records: ${this.processedIds.size}`);
            process.exit(0);
        });
    }
}

// Start the bot
if (require.main === module) {
    const bot = new TwitterBot();
    bot.start().catch(console.error);
}

module.exports = TwitterBot;