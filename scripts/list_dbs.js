const { MongoClient } = require('mongodb');

const uri = "mongodb+srv://tech_db_user:xxQpx3E4TSjv5RlJ@cluster0.yvr1yuw.mongodb.net/?appName=Cluster0";

async function listDatabases() {
  const client = new MongoClient(uri);

  try {
    await client.connect();
    const admin = client.db().admin();
    const result = await admin.listDatabases();
    console.log("Databases:");
    result.databases.forEach(db => console.log(` - ${db.name}`));
  } catch (e) {
    console.error(e);
  } finally {
    await client.close();
  }
}

listDatabases();
