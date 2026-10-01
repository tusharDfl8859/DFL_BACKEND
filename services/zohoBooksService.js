const axios = require("axios");

async function getAccessToken() {

  const response = await axios.post(
    "https://accounts.zoho.in/oauth/v2/token",
    null,
    {
      params: {
        refresh_token: process.env.ZOHO_REFRESH_TOKEN,
        client_id: process.env.ZOHO_CLIENT_ID,
        client_secret: process.env.ZOHO_CLIENT_SECRET,
        grant_type: "refresh_token",
      },
    }
  );

  return response.data.access_token;
}

async function createCustomer(customer) {

  const token = await getAccessToken();

  const payload = {
      contact_name: customer.name,
      company_name: customer.company,
      contact_type: "customer",
      billing_address: {
        attention: customer.company || customer.name,
        address: [
            customer.address
        ].filter(Boolean).join('\n'),
        state: customer.state || ""
      },
      shipping_address: {
        attention: customer.consignee?.consigneeName || customer.consignee?.companyName || " ",
        address: [
            customer.consignee?.addressLine1,
            customer.consignee?.addressLine2
        ].filter(Boolean).join('\n'),
        state: customer.consignee?.state || "",
        city: customer.consignee?.city || "",
        zip: customer.consignee?.pincode || "",
        country: customer.consignee?.country || ""
      },
      email: customer.email,
      phone: customer.phone
  };

  // Only pass GST if it loosely matches the standard Indian GST 15-character format
  // Relaxed regex to ensure minor typos don't cause the GSTIN to be silently dropped
  const gstRegex = /^[a-zA-Z0-9]{14,16}$/i;
  if (customer.gst && customer.gst !== "UNREGISTERED" && gstRegex.test(customer.gst.trim())) {
      payload.gst_no = customer.gst.trim().toUpperCase();
      payload.gst_treatment = "business_gst";
  }

  const config = {
      headers: { Authorization: `Zoho-oauthtoken ${token}` }
  };

  // Check if customer already exists by email or contact_name
  try {
      let searchUrl = null;
      if (customer.email && customer.email !== "noemail@example.com") {
          searchUrl = `https://www.zohoapis.in/books/v3/contacts?email_contains=${encodeURIComponent(customer.email)}&organization_id=${process.env.ZOHO_ORG_ID}`;
      } else if (customer.name && customer.name !== "DFL Customer") {
          searchUrl = `https://www.zohoapis.in/books/v3/contacts?contact_name=${encodeURIComponent(customer.name)}&organization_id=${process.env.ZOHO_ORG_ID}`;
      }

      if (searchUrl) {
          const searchResponse = await axios.get(searchUrl, config);
          if (searchResponse.data.contacts && searchResponse.data.contacts.length > 0) {
              const contactId = searchResponse.data.contacts[0].contact_id;
              console.log(`ℹ️ Zoho Customer found: ${customer.name || customer.email}. Updating details...`);
              try {
                  await axios.put(`https://www.zohoapis.in/books/v3/contacts/${contactId}?organization_id=${process.env.ZOHO_ORG_ID}`, payload, config);
              } catch (updateErr) {
                  console.error("Zoho Customer Update Failed:", updateErr.message);
              }
              return { contact: { contact_id: contactId } };
          }
      }
      
      // If email search yielded no results, fallback to name search
      if (customer.email && customer.email !== "noemail@example.com" && customer.name && customer.name !== "DFL Customer") {
          const nameSearchUrl = `https://www.zohoapis.in/books/v3/contacts?contact_name=${encodeURIComponent(customer.name)}&organization_id=${process.env.ZOHO_ORG_ID}`;
          const nameSearchResponse = await axios.get(nameSearchUrl, config);
          if (nameSearchResponse.data.contacts && nameSearchResponse.data.contacts.length > 0) {
              const contactId = nameSearchResponse.data.contacts[0].contact_id;
              console.log(`ℹ️ Zoho Customer found by name fallback: ${customer.name}. Updating details...`);
              try {
                  await axios.put(`https://www.zohoapis.in/books/v3/contacts/${contactId}?organization_id=${process.env.ZOHO_ORG_ID}`, payload, config);
              } catch (updateErr) {
                  console.error("Zoho Customer Update Failed:", updateErr.message);
              }
              return { contact: { contact_id: contactId } };
          }
      }
  } catch (err) {
      console.error("Zoho Customer Search Failed:", err.message);
  }

  const response = await axios.post(
    `https://www.zohoapis.in/books/v3/contacts?organization_id=${process.env.ZOHO_ORG_ID}`,
    payload,
    config
  );

  return response.data;
}

async function createInvoice(customerId, invoice, existingInvoiceId = null) {

  const token = await getAccessToken();

  let taxId = "";
  let placeOfSupply = "";

  // Map of Indian States to GST Codes
  const stateCodes = {
      "jammu and kashmir": "01", "himachal pradesh": "02", "punjab": "03", "chandigarh": "04", "uttarakhand": "05",
      "haryana": "06", "delhi": "07", "rajasthan": "08", "uttar pradesh": "09", "up": "09", "noida": "09", "bihar": "10",
      "sikkim": "11", "arunachal pradesh": "12", "nagaland": "13", "manipur": "14", "mizoram": "15", "tripura": "16",
      "meghalaya": "17", "assam": "18", "west bengal": "19", "jharkhand": "20", "odisha": "21", "chhattisgarh": "22",
      "madhya pradesh": "23", "gujarat": "24", "daman": "25", "diu": "25", "dadra": "26", "maharashtra": "27",
      "karnataka": "29", "goa": "30", "lakshadweep": "31", "kerala": "32", "tamil nadu": "33", "puducherry": "34",
      "andaman": "35", "telangana": "36", "andhra pradesh": "37", "ladakh": "38"
  };

  // 1. Check GSTIN first
  if (invoice.gst && invoice.gst !== "UNREGISTERED") {
      placeOfSupply = invoice.gst.substring(0, 2);
  } else {
      // 2. Scan address for state name
      const searchString = `${invoice.state || ""} ${invoice.address || ""}`.toLowerCase();
      for (const [stateName, code] of Object.entries(stateCodes)) {
          if (searchString.includes(stateName)) {
              placeOfSupply = code;
              break;
          }
      }
  }

  // 3. Trust DFL's explicit taxType (from invoice panel)
  if (invoice.taxType) {
      if (invoice.taxType === "CGST/SGST") {
          taxId = "3271079000000033290"; // GST18 (Intrastate UP)
          placeOfSupply = "09"; // Force UP to allow CGST/SGST
      } else if (invoice.taxType === "IGST") {
          taxId = "3271079000000033130"; // IGST18 (Interstate)
          // Prevent Error 3032: If IGST but state is UP (09), force it out of UP (e.g. 07 Delhi)
          if (placeOfSupply === "09" || !placeOfSupply) placeOfSupply = "07";
      }
  } else if (invoice.tax) { // Legacy fallback
      if (invoice.tax.cgst > 0 || invoice.tax.sgst > 0) {
          taxId = "3271079000000033290"; 
          placeOfSupply = "09";
      } else if (invoice.tax.igst > 0) {
          taxId = "3271079000000033130"; 
          if (placeOfSupply === "09" || !placeOfSupply) placeOfSupply = "07";
      }
  }

  // 4. Absolute Fallback
  if (!taxId) {
      if (placeOfSupply === "09") {
          taxId = "3271079000000033290"; // GST18
      } else {

          taxId = "3271079000000033130"; // IGST18
          if (!placeOfSupply) placeOfSupply = "07";
      }
  }

  const invoicePayload = {
      customer_id: customerId,
      invoice_number: invoice.invoiceNumber || invoice.invoiceId || "DFL-UNKNOWN",
      reference_number: invoice.invoiceNumber || invoice.invoiceId || "DFL-UNKNOWN",
      ...(invoice.invoiceDate && { date: new Date(invoice.invoiceDate).toISOString().split('T')[0] }),
      ...(placeOfSupply && { place_of_supply: placeOfSupply }),
      ...(invoice.gst && invoice.gst !== "UNREGISTERED" && invoice.gst.length >= 14 ? { gst_no: invoice.gst.trim().toUpperCase(), gst_treatment: "business_gst" } : {}),
      line_items: [
        {
          name: invoice.serviceName || "Shipping Charges",
          quantity: 1,
          rate: invoice.subtotal || invoice.totalAmount || 500,
          hsn_or_sac: "996812",
          ...(taxId ? { tax_id: taxId } : {})
        }
      ]
  };

  const url = existingInvoiceId 
    ? `https://www.zohoapis.in/books/v3/invoices/${existingInvoiceId}?organization_id=${process.env.ZOHO_ORG_ID}&ignore_auto_number_generation=true`
    : `https://www.zohoapis.in/books/v3/invoices?organization_id=${process.env.ZOHO_ORG_ID}&ignore_auto_number_generation=true`;

  const config = {
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
      }
  };

  const response = existingInvoiceId 
    ? await axios.put(url, invoicePayload, config)
    : await axios.post(url, invoicePayload, config);

  return response.data;

}

module.exports = {
  getAccessToken,
  createCustomer,
  createInvoice,
};
