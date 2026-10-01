const { MongoClient } = require('mongodb');

const uri = "mongodb+srv://tech_db_user:xxQpx3E4TSjv5RlJ@cluster0.yvr1yuw.mongodb.net/dfl_staging?appName=Cluster0";

async function checkDb() {
  const client = new MongoClient(uri);

  try {
    await client.connect();
    const db = client.db('dfl_staging');
    const collections = await db.listCollections().toArray();
    console.log(`Collections in 'dfl_staging': ${collections.length}`);
    for(const col of collections) {
         const count = await db.collection(col.name).countDocuments();
         console.log(` - ${col.name}: ${count}`);
    }
  } catch (e) {
    console.error(e);
  } finally {
    await client.close();
  }
}

checkDb();
