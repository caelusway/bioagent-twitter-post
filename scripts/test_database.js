require('dotenv').config();
const { Client } = require('pg');

async function testDatabase() {
    console.log('🧪 Testing enhanced database functionality...');
    
    const client = new Client({
        connectionString: process.env.RAILWAY_POSTGRES_URL || process.env.POSTGRES_URL,
        ssl: process.env.RAILWAY_POSTGRES_URL ? { rejectUnauthorized: false } : false
    });

    try {
        await client.connect();
        console.log('✅ Connected to PostgreSQL database');

        // Test insert with enhanced data
        const testRecordId = `test-${Date.now()}`;
        const testTweetId = `${Date.now()}`;
        const testReplyToId = '1234567890';
        const testContent = 'This is a test tweet content';
        const testPoiTx = 'https://etherscan.io/tx/0x123...';

        console.log(`\n📝 Testing insert with record ID: ${testRecordId}`);
        
        await client.query(`
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
        `, [testRecordId, testTweetId, testReplyToId, 'success', testContent.length, testPoiTx]);

        console.log('✅ Successfully inserted test record');

        // Test query
        const result = await client.query(`
            SELECT * FROM processed_records 
            WHERE record_id = $1
        `, [testRecordId]);

        if (result.rows.length > 0) {
            const record = result.rows[0];
            console.log('\n📋 Retrieved test record:');
            console.log(`  Record ID: ${record.record_id}`);
            console.log(`  Posted Tweet ID: ${record.posted_tweet_id}`);
            console.log(`  Reply To Tweet ID: ${record.reply_to_tweet_id}`);
            console.log(`  Status: ${record.status}`);
            console.log(`  Content Length: ${record.content_length}`);
            console.log(`  POI Transaction: ${record.poi_transaction}`);
            console.log(`  Processed At: ${record.processed_at}`);
            console.log(`  Updated At: ${record.updated_at}`);
        }

        // Test upsert (update existing)
        console.log('\n🔄 Testing upsert functionality...');
        await client.query(`
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
                status = 'updated',
                updated_at = NOW()
        `, [testRecordId, `${testTweetId}-updated`, testReplyToId, 'updated', testContent.length, testPoiTx]);

        console.log('✅ Successfully updated test record');

        // Clean up test record
        await client.query('DELETE FROM processed_records WHERE record_id = $1', [testRecordId]);
        console.log('🧹 Cleaned up test record');

        console.log('\n🎉 Database functionality test completed successfully!');
        
    } catch (error) {
        console.error('❌ Database test failed:', error.message);
        throw error;
    } finally {
        await client.end();
    }
}

if (require.main === module) {
    testDatabase().catch(console.error);
}

module.exports = testDatabase;