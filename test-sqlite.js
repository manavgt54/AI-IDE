import { initSchema, upsertUserAndCreateSession, verifyTerminalSession, saveFile, readFileByName, getDatabaseStats } from './src/db/sqlite.js'

async function testSQLiteSetup() {
  console.log('🧪 Testing SQLite setup...')
  
  try {
    // Initialize schema
    console.log('1. Initializing schema...')
    await initSchema()
    console.log('✅ Schema initialized')
    
    // Create a test user and session
    console.log('2. Creating test user and session...')
    const result = await upsertUserAndCreateSession({
      googleId: 'test_google_123',
      email: 'test@example.com',
      provider: 'google'
    })
    console.log('✅ User and session created:', result)
    
    // Verify terminal session
    console.log('3. Verifying terminal session...')
    const sessionInfo = await verifyTerminalSession(result.sessionId, result.terminalToken)
    console.log('✅ Session verified:', sessionInfo)
    
    // Test file operations
    console.log('4. Testing file operations...')
    await saveFile({
      sessionId: result.sessionId,
      filename: 'test.txt',
      content: 'Hello SQLite!'
    })
    console.log('✅ File saved')
    
    const fileContent = await readFileByName({
      sessionId: result.sessionId,
      filename: 'test.txt'
    })
    console.log('✅ File read:', fileContent)
    
    // Get database stats
    console.log('5. Getting database stats...')
    const stats = await getDatabaseStats()
    console.log('✅ Database stats:', stats)
    
    console.log('🎉 All tests passed! SQLite setup is working correctly.')
    
  } catch (error) {
    console.error('❌ Test failed:', error)
    process.exit(1)
  }
}

testSQLiteSetup()
