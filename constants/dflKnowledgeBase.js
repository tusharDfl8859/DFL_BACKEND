/**
 * Comprehensive DFL Group Knowledge Base
 * Authoritative facts compiled from DFL Express public pages, branch directories, privacy policy, and terms of service.
 */

const DFL_COMPANY_INFO = {
    legalName: "Demira Freight Linkers India Private Limited",
    tradeNames: ["DFL Express", "The DFL Group", "DFL Group Logistics"],
    tagline: "Global Logistics & Cross-Border Freight Solutions",
    website: "https://express.thedflgroup.com",
    customerSupportEmail: "courier@thedflgroup.com",
    salesEmail: "sales@thedflgroup.com",
    supportPhone: "+91 9355151122",
    whatsappNumber: "+91 9355376634",
    headquarters: "B 331, Logix Technova, Block B, Sector 132, Noida, UP 201305, India"
};

const DFL_BRANCHES = [
    {
        city: "Noida",
        type: "Headquarters (HQ)",
        country: "India",
        address: "B 331, Logix Technova, Block B, Sector 132, Noida, UP 201305",
        phones: ["+91 9355151122"],
        emails: ["courier@thedflgroup.com"],
        operatingHours: "Monday - Saturday: 9:30 AM - 6:30 PM"
    },
    {
        city: "Mumbai",
        type: "Regional Hub",
        country: "India",
        address: "231 Sai Chambers, B Wings, CBD Belapur, Navi Mumbai 400614",
        phones: ["+91 9971076083"],
        emails: ["kp@dflindia.in"],
        operatingHours: "Monday - Saturday: 9:30 AM - 6:30 PM"
    },
    {
        city: "Ahmedabad",
        type: "Regional Hub",
        country: "India",
        address: "D/1001, Titanium City Centre, Satellite, Ahmedabad, Gujarat 380015",
        phones: ["+91 9319524092"],
        emails: ["ts@dflindia.in"],
        operatingHours: "Monday - Saturday: 9:30 AM - 6:30 PM"
    },
    {
        city: "Nagina",
        type: "Regional Hub",
        country: "India",
        address: "Shop No 8, Ganna Samiti Road, Muneem Chowk, Lal Sarai Nagina, District Bijnor, Uttar Pradesh – 246762",
        phones: ["+91 9355037796"],
        emails: ["ts@dflindia.in"],
        operatingHours: "Monday - Saturday: 9:30 AM - 6:30 PM"
    },
    {
        city: "Vadodara",
        type: "Regional Hub",
        country: "India",
        address: "LR-412, 04th Floor, Park Paradise Building, Vadsar, Vadodara, Near Gross Road, Gujarat-390010",
        phones: ["+91 7874088394"],
        emails: ["baroda@thedflgroup.com"],
        operatingHours: "Monday - Saturday: 9:30 AM - 6:30 PM"
    },
    {
        city: "Bangkok",
        type: "International Branch",
        country: "Thailand",
        address: "DFL International Co. Ltd., 169 Soi Udomsuk 58, Bangkok 10260",
        phones: ["+66 81 812 6021"],
        emails: ["jameswaltercop@gmail.com"],
        operatingHours: "Monday - Friday: 9:00 AM - 6:00 PM"
    },
    {
        city: "Dubai",
        type: "International Branch",
        country: "UAE",
        address: "DFL Int. Logistics LLC., CBD Bank Bldg, Bur Dubai, Dubai, United Arab Emirates",
        phones: ["+97 1503998139"],
        emails: ["sales@thedflgroup.com"],
        operatingHours: "Sunday - Thursday: 9:00 AM - 6:00 PM"
    }
];

const DFL_SERVICES = {
    expressCourier: "Fast international and domestic express courier shipping with door-to-door tracking, real-time status updates, and duty estimation.",
    airFreight: "High-speed international air cargo shipping for heavy packages, commercial exports, temperature-controlled freight, and urgent shipments.",
    oceanFreight: "Full Container Load (FCL) and Less than Container Load (LCL) global sea freight options for large commercial cargo.",
    customsClearance: "Seamless Indian export customs processing including CSB-IV (Non-Commercial / Express) and CSB-V (E-commerce Commercial Export) filings, AD Code registration, and HSN classification.",
    warehousing: "Secure storage, pick & pack, inventory management, and multi-channel e-commerce fulfillment services.",
    ecommerceIntegrations: "Direct API and platform integrations for Amazon Seller Central, eBay, Etsy, and custom storefronts with automated AWB generation and tracking sync."
};

const DFL_PRIVACY_POLICY_SUMMARY = `
- **Company Identity**: Demira Freight Linkers India Pvt Ltd (DFL Express / DFL Group).
- **Information Collected**: Personal details (name, email, phone, billing address), KYC documents (Aadhaar, PAN, GSTIN, IEC code), shipment & recipient information, and digital usage data.
- **Data Protection & Storage**: Data is protected using SSL/TLS encryption, strictly stored in secure cloud infrastructure, and accessed only for operational & legal compliance.
- **Data Usage**: Strictly used to provide logistics services, perform KYC checks, issue shipping labels, clear customs, process payments, and provide customer support.
- **Third-Party Sharing**: Data is shared ONLY with authorized carrier partners (e.g. Skynet, TPL, Envia), customs authorities, and secure payment gateways. DFL NEVER sells user data to third parties.
- **User Rights**: Users can view, update, or request deletion of their personal data by contacting privacy@thedflgroup.com or raising a support ticket.
`;

const DFL_TERMS_SUMMARY = `
- **Acceptance of Terms**: Using DFL Express platforms, APIs, or services constitutes full acceptance of DFL Terms & Conditions.
- **User Responsibilities**: Users are responsible for providing accurate recipient addresses, authentic invoice details, compliant KYC documents, and ensuring packages contain NO prohibited items.
- **Shipment Insurance & Claims**: Standard carrier liability rules apply. High-value shipments should have optional insurance coverage. Damage or loss claims must be submitted within 7 days of delivery or expected delivery date.
- **Payment & Wallet**: Wallet top-ups are non-transferable. Unused wallet balances can be refunded upon account closure request subject to verification within 3-5 business days. Cancelled shipments auto-refund to DFL Wallet within 24-48 hours.
- **Prohibited Cargo**: Users must strictly avoid shipping illegal, hazardous, or restricted items. Inaccurate declarations may lead to customs seizure and account suspension.
`;

const DFL_PROHIBITED_ITEMS = [
    "Explosives, fireworks, ammunition, and firearms",
    "Flammable liquids & solids (gasoline, lighter fluid, oil paints)",
    "Compressed gases, aerosol cans, and toxic chemicals",
    "Currency, banknotes, precious metals, and bullion",
    "Illegal drugs, narcotics, and unauthorized pharmaceuticals",
    "Loose lithium-metal or uncertified lithium-ion batteries",
    "Perishable food items without required cold-chain clearance",
    "Counterfeit goods and pirated materials"
];

module.exports = {
    DFL_COMPANY_INFO,
    DFL_BRANCHES,
    DFL_SERVICES,
    DFL_PRIVACY_POLICY_SUMMARY,
    DFL_TERMS_SUMMARY,
    DFL_PROHIBITED_ITEMS
};
