require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');

async function migrateProcessedIds() {
    console.log('🔄 Migrating processed IDs from JSON to PostgreSQL...');
    
    // Check if JSON file exists
    if (!fs.existsSync('processed_ids.json')) {
        console.log('ℹ️  No processed_ids.json file found. Nothing to migrate.');
        return;
    }

    const client = new Client({
        connectionString: process.env.RAILWAY_POSTGRES_URL || process.env.POSTGRES_URL,
        ssl: process.env.RAILWAY_POSTGRES_URL ? { rejectUnauthorized: false } : false
    });

    try {
        await client.connect();
        console.log('✅ Connected to PostgreSQL database');

        // Create table with enhanced schema
        await client.query(`
            CREATE TABLE IF NOT EXISTS processed_records (
                record_id VARCHAR(255) PRIMARY KEY,
                processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                posted_tweet_id VARCHAR(255),
                reply_to_tweet_id VARCHAR(255),
                status VARCHAR(50) DEFAULT 'migrated',
                content_length INTEGER,
                poi_transaction TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Add indexes for better performance
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_processed_records_processed_at 
            ON processed_records(processed_at)
        `);
        
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_processed_records_status 
            ON processed_records(status)
        `);

        // Read JSON data
        const data = JSON.parse(fs.readFileSync('processed_ids.json', 'utf8'));
        const processedIds = data.processed_ids || [];

        console.log(`📋 Found ${processedIds.length} processed IDs to migrate`);

        let migratedCount = 0;
        for (const recordId of processedIds) {
            try {
                await client.query(`
                    INSERT INTO processed_records (record_id, status, processed_at) 
                    VALUES ($1, 'migrated', NOW()) 
                    ON CONFLICT (record_id) DO UPDATE SET
                        status = 'migrated',
                        updated_at = NOW()
                `, [recordId]);
                migratedCount++;
            } catch (error) {
                console.error(`❌ Failed to migrate ID ${recordId}:`, error.message);
            }
        }

        console.log(`✅ Successfully migrated ${migratedCount} processed IDs to database`);

        // Create backup of JSON file
        fs.copyFileSync('processed_ids.json', 'processed_ids_backup.json');
        console.log('📦 Created backup: processed_ids_backup.json');

        console.log('🎉 Migration completed successfully!');
        
    } catch (error) {
        console.error('❌ Migration failed:', error.message);
        throw error;
    } finally {
        await client.end();
    }
}

if (require.main === module) {
    migrateProcessedIds().catch(console.error);
}

module.exports = migrateProcessedIds;