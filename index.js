require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');

class TwitterAnswersReader {
    constructor() {
        this.client = new Client({
            connectionString: process.env.POSTGRES_URL,
            ssl: false
        });
    }

    async connect() {
        try {
            await this.client.connect();
            console.log('✅ Connected to PostgreSQL database');
            return true;
        } catch (error) {
            console.error('❌ Failed to connect to database:', error.message);
            return false;
        }
    }

    async readTwitterAnswers() {
        try {
            console.log('📋 Reading twitter_answers table...');
            
            // First, check table structure
            const tableInfo = await this.client.query(`
                SELECT column_name, data_type 
                FROM information_schema.columns 
                WHERE table_name = 'twitter_answers'
                ORDER BY ordinal_position;
            `);
            
            console.log('\n📊 Table structure:');
            tableInfo.rows.forEach(row => {
                console.log(`   ${row.column_name}: ${row.data_type}`);
            });
            
            // Get total count
            const countResult = await this.client.query('SELECT COUNT(*) as total FROM twitter_answers');
            const totalRows = parseInt(countResult.rows[0].total);
            console.log(`\n📈 Total records: ${totalRows}`);
            
            if (totalRows === 0) {
                console.log('⚠️  No records found in twitter_answers table');
                return [];
            }
            
            // Read all records
            const result = await this.client.query(`
                SELECT * FROM twitter_answers 
                ORDER BY id DESC 
                LIMIT 100
            `);
            
            console.log(`\n✅ Retrieved ${result.rows.length} records`);
            
            // Show first few records as preview
            if (result.rows.length > 0) {
                console.log('\n📄 Sample records:');
                result.rows.slice(0, 3).forEach((row, index) => {
                    console.log(`\n--- Record ${index + 1} ---`);
                    Object.keys(row).forEach(key => {
                        const value = row[key];
                        if (typeof value === 'string' && value.length > 100) {
                            console.log(`${key}: ${value.substring(0, 100)}...`);
                        } else {
                            console.log(`${key}: ${value}`);
                        }
                    });
                });
            }
            
            return result.rows;
            
        } catch (error) {
            console.error('❌ Error reading twitter_answers:', error.message);
            return [];
        }
    }

    async saveToFile(data) {
        try {
            const output = {
                timestamp: new Date().toISOString(),
                source: 'postgresql_twitter_answers',
                total_records: data.length,
                records: data
            };
            
            fs.writeFileSync('twitter_answers.json', JSON.stringify(output, null, 2));
            console.log(`\n💾 Saved ${data.length} records to twitter_answers.json`);
            
            return true;
        } catch (error) {
            console.error('❌ Error saving to file:', error.message);
            return false;
        }
    }

    async disconnect() {
        try {
            await this.client.end();
            console.log('✅ Disconnected from database');
        } catch (error) {
            console.error('❌ Error disconnecting:', error.message);
        }
    }

    async run() {
        console.log('🔍 Twitter Answers Database Reader');
        console.log('==================================');
        
        const connected = await this.connect();
        if (!connected) {
            process.exit(1);
        }
        
        try {
            const data = await this.readTwitterAnswers();
            
            if (data.length > 0) {
                await this.saveToFile(data);
                console.log('\n🎉 Successfully read and saved twitter_answers data!');
            } else {
                console.log('\n⚠️  No data to save');
            }
            
        } finally {
            await this.disconnect();
        }
    }
}

// Run the reader
if (require.main === module) {
    const reader = new TwitterAnswersReader();
    reader.run().catch(console.error);
}

module.exports = TwitterAnswersReader;