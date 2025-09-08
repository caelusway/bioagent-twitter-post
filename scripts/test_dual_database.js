require('dotenv').config();
const { Client } = require('pg');

async function testDualDatabase() {
    console.log('🧪 Testing dual database setup...');
    
    // Test main database connection
    console.log('\n📊 Testing Main Database (twitter_answers)...');
    const mainClient = new Client({
        connectionString: process.env.POSTGRES_URL,
        ssl: false
    });

    try {
        await mainClient.connect();
        console.log('✅ Connected to main PostgreSQL database');
        
        // Test querying twitter_answers table
        const result = await mainClient.query(`
            SELECT COUNT(*) as count 
            FROM twitter_answers 
            LIMIT 1
        `);
        console.log(`✅ Main database accessible, twitter_answers table found`);
        console.log(`📋 Total records in twitter_answers: ${result.rows[0].count}`);
        
    } catch (error) {
        console.error('❌ Main database test failed:', error.message);
    } finally {
        await mainClient.end();
    }

    // Test Railway database connection
    console.log('\n🚂 Testing Railway Database (processed_records)...');
    const railwayClient = new Client({
        connectionString: process.env.RAILWAY_POSTGRES_URL,
        ssl: { rejectUnauthorized: false }
    });

    try {
        await railwayClient.connect();
        console.log('✅ Connected to Railway PostgreSQL database');
        
        // Test querying processed_records table
        const result = await railwayClient.query(`
            SELECT COUNT(*) as count 
            FROM processed_records
        `);
        console.log(`✅ Railway database accessible, processed_records table found`);
        console.log(`📋 Total records in processed_records: ${result.rows[0].count}`);
        
        // Test insert/delete
        const testId = `test-dual-${Date.now()}`;
        await railwayClient.query(`
            INSERT INTO processed_records (record_id, status) 
            VALUES ($1, 'test')
        `, [testId]);
        console.log('✅ Test record inserted successfully');
        
        await railwayClient.query(`
            DELETE FROM processed_records 
            WHERE record_id = $1
        `, [testId]);
        console.log('✅ Test record cleaned up successfully');
        
    } catch (error) {
        console.error('❌ Railway database test failed:', error.message);
        if (error.code === '42P01') {
            console.log('ℹ️  processed_records table not found - run the bot once to create it');
        }
    } finally {
        await railwayClient.end();
    }

    console.log('\n🎉 Dual database setup test completed!');
    console.log('📝 Summary:');
    console.log('   • Main Database: Used for twitter_answers polling');
    console.log('   • Railway Database: Used for processed_records tracking');
}

if (require.main === module) {
    testDualDatabase().catch(console.error);
}

module.exports = testDualDatabase;