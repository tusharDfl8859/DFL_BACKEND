const { MongoClient } = require('mongodb');

// Source: Main Database
const sourceUri = "mongodb+srv://tech_db_user:xxQpx3E4TSjv5RlJ@cluster0.yvr1yuw.mongodb.net/?appName=Cluster0";
const sourceDbName = "test";

// Destination: Test Database
const destUri = "mongodb+srv://tech_db_user:xxQpx3E4TSjv5RlJ@cluster0.yvr1yuw.mongodb.net/dfl_staging?appName=Cluster0";
const destDbName = "dfl_staging";

async function migrate() {
  const sourceClient = new MongoClient(sourceUri);
  const destClient = new MongoClient(destUri);

  try {
    console.log("Connecting to databases...");
    await sourceClient.connect();
    await destClient.connect();
    
    const sourceDb = sourceClient.db(sourceDbName);
    const destDb = destClient.db(destDbName);

    console.log(`Connected. Source: ${sourceDbName}, Destination: ${destDbName}`);

    // Get all collections from source
    const collections = await sourceDb.listCollections().toArray();
    console.log(`Found ${collections.length} collections in source.`);

    for (const colInfo of collections) {
      const colName = colInfo.name;
      console.log(`Processing collection: ${colName}...`);

      const sourceCol = sourceDb.collection(colName);
      const destCol = destDb.collection(colName);

      const documents = await sourceCol.find({}).toArray();
      
      if (documents.length === 0) {
        console.log(`  - No documents found in source ${colName}. Skipping.`);
        continue;
      }

      console.log(`  - Found ${documents.length} documents in source.`);

      let insertedCount = 0;
      let skippedCount = 0;
      let errorCount = 0;

      // Prepare bulk write operations
      // We use insertOne to leverage the unique _id constraint.
      // If _id exists, it will fail (which we catch/ignore), preserving existing data.
      
      const bulkOps = documents.map(doc => ({
        insertOne: {
          document: doc
        }
      }));

      if (bulkOps.length > 0) {
        try {
          // ordered: false ensures that if one insert fails (duplicate key), the others still proceed.
          const result = await destCol.bulkWrite(bulkOps, { ordered: false });
          insertedCount = result.insertedCount;
          skippedCount = documents.length - insertedCount; // Roughly, assuming failures are duplicates
        } catch (e) {
             if (e.writeErrors) {
                 // Some documents failed (duplicates), but others might have succeeded
                 insertedCount = e.result.nInserted;
                 skippedCount = e.writeErrors.length;
                 // verify if all errors are duplicate keys (code 11000)
                 const nonDuplicateErrors = e.writeErrors.filter(err => err.code !== 11000);
                 if(nonDuplicateErrors.length > 0) {
                     console.error(`  - Critical errors in ${colName}:`, nonDuplicateErrors);
                     errorCount = nonDuplicateErrors.length;
                 }
             } else {
                 console.error(`  - Bulk write failed entirely for ${colName}:`, e);
                 errorCount = documents.length;
             }
        }
      }

      console.log(`  - Result for ${colName}: Inserted: ${insertedCount}, Skipped (Exists): ${skippedCount}, Errors: ${errorCount}`);
    }

    console.log("\nMigration completed successfully!");

  } catch (e) {
    console.error("Migration failed:", e);
  } finally {
    await sourceClient.close();
    await destClient.close();
  }
}

migrate();
