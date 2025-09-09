# BioAgent Twitter Bot

Automated Twitter bot that polls PostgreSQL database for bioagent answers and posts them as replies on Twitter (@Aubrai_).

## Features

✅ **Database Polling**: Checks PostgreSQL every 60 seconds for new records  
✅ **Smart Filtering**: Only processes records with `poi_transaction` blockchain proof  
✅ **Content Cleaning**: Removes scientific paper references before posting  
✅ **Reply-Only Mode**: Posts as replies to original tweets (never creates new tweets)  
✅ **Blue Checkmark Support**: Supports up to 25,000 character tweets  
✅ **Comprehensive Logging**: Detailed logs with error tracking and statistics  
✅ **Duplicate Prevention**: Tracks processed records to avoid duplicates  

## Setup

1. **Install dependencies:**
```bash
npm install
```

2. **Configure environment variables in `.env`:**
```env
# Main Database (for twitter_answers polling)
POSTGRES_URL=postgresql://user:pass@host:port/dbname
# Railway Database (for processed_records storage only)
RAILWAY_POSTGRES_URL=postgresql://user:pass@railway:port/dbname

# Twitter API (from https://developer.twitter.com)
TWITTER_API_KEY=your_twitter_api_key
TWITTER_API_SECRET_KEY=your_twitter_secret_key
TWITTER_ACCESS_TOKEN=your_access_token
TWITTER_ACCESS_TOKEN_SECRET=your_access_token_secret
```

## Usage

### Start the bot (main command):
```bash
npm start
```

### Read database records only:
```bash
npm run read-db
```

### Migrate existing processed IDs to database (one-time):
```bash
npm run migrate
```

### Update database schema (for existing deployments):
```bash
npm run update-schema
```

### Check database schema and records:
```bash
npm run check-schema
```

### Test database functionality:
```bash
npm run test-db
```

### Test dual database setup:
```bash
npm run test-dual-db
```

## Project Structure

```
bioagent-twitter-post/
├── twitter_bot.js          # Main bot application
├── index.js               # Database reader utility
├── package.json           # Dependencies and scripts
├── README.md              # Documentation
├── .env                   # Environment variables (not in git)
├── scripts/               # Utility scripts
│   ├── migrate_processed_ids.js     # Migration script
│   ├── update_schema.js            # Schema update script  
│   ├── check_schema.js             # Schema inspection tool
│   └── test_database.js            # Database functionality test
└── logs/                  # Application logs (auto-created)
```

## How It Works

1. **Database Polling**: Every 60 seconds, queries `twitter_answers` table for new records
2. **Filtering**: Only processes records that have:
   - `poi_transaction` (blockchain proof URL)
   - `tweet_id` (original tweet to reply to)
   - `answer` (content to post)
3. **Content Cleaning**: Removes scientific papers and DOI references
4. **Twitter Posting**: Posts cleaned content as reply to original tweet
5. **Logging**: Records all activities in `logs/` directory

## Database Architecture

The bot uses **dual database setup**:

### Main Database (POSTGRES_URL)
Contains the `twitter_answers` table with columns:
- `id`: Unique identifier
- `answer`: Tweet content  
- `tweet_id`: Original tweet ID to reply to
- `poi_transaction`: Blockchain proof URL
- `created_at`: Timestamp

### Railway Database (RAILWAY_POSTGRES_URL) 
The bot automatically creates and maintains a `processed_records` table with:
- `record_id`: Unique identifier from twitter_answers
- `posted_tweet_id`: ID of the tweet that was posted as reply
- `reply_to_tweet_id`: Original tweet ID that was replied to
- `status`: Processing status (success, skipped_tweet_deleted, etc.)
- `content_length`: Length of the cleaned tweet content
- `poi_transaction`: Blockchain proof URL
- `processed_at`: When the record was processed
- `updated_at`: When the record was last updated

This provides comprehensive analytics and tracking of all bot activities.

**Benefits of Dual Database Setup:**
- 🔒 **Security**: Keeps main data separate from tracking data
- 🚀 **Performance**: Railway database optimized for high-frequency writes  
- 📊 **Analytics**: Dedicated database for bot metrics and monitoring
- 🔄 **Scalability**: Independent scaling of storage and processing databases
- 🛡️ **Resilience**: Automatic connection recovery and error handling

## Logging

The bot creates comprehensive logs in the `logs/` directory:
- `bot-YYYY-MM-DD.log`: Daily activity logs
- `errors.log`: All errors
- `activity_summary.json`: Daily statistics

## Rate Limiting

- 2-second delay between posts to avoid Twitter rate limits
- Processes records sequentially to maintain order

## Error Handling & Resilience

- **Database Connection Recovery**: Automatically reconnects on connection drops
- **Retry Logic**: Up to 3 retry attempts with exponential backoff
- **Connection Health Monitoring**: Real-time tracking of database connection status
- **Graceful Error Handling**: Skips records if original tweet is deleted
- **Process Resilience**: Global error handlers prevent crashes
- **Comprehensive Logging**: All errors logged with full context for debugging
- **Dual Database Isolation**: Main database issues don't affect tracking database