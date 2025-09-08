require('dotenv').config();
const { Client } = require('pg');

async function checkSchema() {
    console.log('🔍 Checking processed_records table schema...');
    
    const client = new Client({
        connectionString: process.env.RAILWAY_POSTGRES_URL || process.env.POSTGRES_URL,
        ssl: process.env.RAILWAY_POSTGRES_URL ? { rejectUnauthorized: false } : false
    });

    try {
        await client.connect();
        console.log('✅ Connected to PostgreSQL database');

        // Check table structure
        const schemaResult = await client.query(`
            SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns 
            WHERE table_name = 'processed_records'
            ORDER BY ordinal_position;
        `);
        
        console.log('\n📊 Table Schema:');
        console.log('================');
        schemaResult.rows.forEach(row => {
            console.log(`${row.column_name}: ${row.data_type} ${row.is_nullable === 'NO' ? '(NOT NULL)' : '(nullable)'} ${row.column_default ? `default: ${row.column_default}` : ''}`);
        });

        // Check indexes
        const indexResult = await client.query(`
            SELECT indexname, indexdef 
            FROM pg_indexes 
            WHERE tablename = 'processed_records';
        `);
        
        console.log('\n🔗 Indexes:');
        console.log('===========');
        indexResult.rows.forEach(row => {
            console.log(`${row.indexname}: ${row.indexdef}`);
        });

        // Check sample data
        const dataResult = await client.query(`
            SELECT record_id, posted_tweet_id, status, content_length, processed_at
            FROM processed_records 
            ORDER BY processed_at DESC 
            LIMIT 3;
        `);
        
        console.log('\n📋 Sample Records:');
        console.log('==================');
        dataResult.rows.forEach(row => {
            console.log(`${row.record_id}: status=${row.status}, tweet_id=${row.posted_tweet_id}, length=${row.content_length}, processed=${row.processed_at}`);
        });

        console.log(`\n📈 Total records: ${dataResult.rowCount || 0}`);
        
    } catch (error) {
        console.error('❌ Schema check failed:', error.message);
        throw error;
    } finally {
        await client.end();
    }
}

if (require.main === module) {
    checkSchema().catch(console.error);
}

module.exports = checkSchema;