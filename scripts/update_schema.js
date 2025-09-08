require('dotenv').config();
const { Client } = require('pg');

async function updateSchema() {
    console.log('🔄 Updating processed_records table schema...');
    
    const client = new Client({
        connectionString: process.env.RAILWAY_POSTGRES_URL || process.env.POSTGRES_URL,
        ssl: process.env.RAILWAY_POSTGRES_URL ? { rejectUnauthorized: false } : false
    });

    try {
        await client.connect();
        console.log('✅ Connected to PostgreSQL database');

        // Add missing columns if they don't exist
        const alterQueries = [
            // Rename tweet_id to posted_tweet_id if it exists
            `DO $$ 
            BEGIN
                IF EXISTS(SELECT * FROM information_schema.columns WHERE table_name='processed_records' and column_name='tweet_id') THEN
                    ALTER TABLE processed_records RENAME COLUMN tweet_id TO posted_tweet_id;
                END IF;
            END $$;`,
            
            // Add status column
            `DO $$ 
            BEGIN
                IF NOT EXISTS(SELECT * FROM information_schema.columns WHERE table_name='processed_records' and column_name='status') THEN
                    ALTER TABLE processed_records ADD COLUMN status VARCHAR(50) DEFAULT 'migrated';
                END IF;
            END $$;`,
            
            // Add content_length column
            `DO $$ 
            BEGIN
                IF NOT EXISTS(SELECT * FROM information_schema.columns WHERE table_name='processed_records' and column_name='content_length') THEN
                    ALTER TABLE processed_records ADD COLUMN content_length INTEGER;
                END IF;
            END $$;`,
            
            // Add poi_transaction column
            `DO $$ 
            BEGIN
                IF NOT EXISTS(SELECT * FROM information_schema.columns WHERE table_name='processed_records' and column_name='poi_transaction') THEN
                    ALTER TABLE processed_records ADD COLUMN poi_transaction TEXT;
                END IF;
            END $$;`,
            
            // Add updated_at column
            `DO $$ 
            BEGIN
                IF NOT EXISTS(SELECT * FROM information_schema.columns WHERE table_name='processed_records' and column_name='updated_at') THEN
                    ALTER TABLE processed_records ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
                END IF;
            END $$;`
        ];

        for (const query of alterQueries) {
            try {
                await client.query(query);
                console.log('✅ Schema update query executed');
            } catch (error) {
                console.log('⚠️  Schema update query result:', error.message);
            }
        }

        // Create indexes
        try {
            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_processed_records_processed_at 
                ON processed_records(processed_at)
            `);
            console.log('✅ Created processed_at index');
        } catch (error) {
            console.log('⚠️  Index creation result:', error.message);
        }

        try {
            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_processed_records_status 
                ON processed_records(status)
            `);
            console.log('✅ Created status index');
        } catch (error) {
            console.log('⚠️  Index creation result:', error.message);
        }

        // Update existing records with default status
        const updateResult = await client.query(`
            UPDATE processed_records 
            SET status = 'migrated', updated_at = NOW() 
            WHERE status IS NULL
        `);
        
        console.log(`✅ Updated ${updateResult.rowCount} existing records with default status`);

        console.log('🎉 Schema update completed successfully!');
        
    } catch (error) {
        console.error('❌ Schema update failed:', error.message);
        throw error;
    } finally {
        await client.end();
    }
}

if (require.main === module) {
    updateSchema().catch(console.error);
}

module.exports = updateSchema;