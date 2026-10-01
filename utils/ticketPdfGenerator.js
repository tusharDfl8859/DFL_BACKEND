const PDFDocument = require('pdfkit');
const cloudinary = require('cloudinary').v2;
const stream = require('stream');
const path = require('path');

const uploadToCloudinary = (buffer, folder, filename) => {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            {
                folder: folder,
                public_id: filename,
                resource_type: 'raw',
                format: 'pdf'
            },
            (error, result) => {
                if (error) return reject(error);
                resolve(result);
            }
        );
        const bufferStream = new stream.PassThrough();
        bufferStream.end(buffer);
        bufferStream.pipe(uploadStream);
    });
};

const createTicketBuffer = async (ticket) => {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
            const buffers = [];

            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => {
                const pdfBuffer = Buffer.concat(buffers);
                resolve(pdfBuffer);
            });

            // Styling
            const primaryColor = '#0B4F6C';
            const textColor = '#333333';
            const fontBold = 'Helvetica-Bold';
            const fontRegular = 'Helvetica';

            // Logo
            try {
                const logoPath = path.join(__dirname, '../../Frontend/src/assets/dfl_longo.png');
                doc.image(logoPath, 40, 40, { width: 140 });
            } catch (e) {
                // Suppress logo warning
            }

            // Header Info
            doc.font(fontBold).fontSize(20).fillColor(primaryColor).text('SUPPORT TICKET', 350, 45, { align: 'right' });
            doc.font(fontRegular).fontSize(10).fillColor(textColor).text(`Ticket ID: ${ticket.ticketId}`, 350, 70, { align: 'right' });
            doc.text(`Date Raised: ${new Date(ticket.createdAt).toLocaleDateString('en-GB')}`, 350, 85, { align: 'right' });
            doc.text(`Status: ${ticket.status}`, 350, 100, { align: 'right' });

            doc.moveDown(3);

            // Divider
            doc.moveTo(40, 130).lineTo(555, 130).strokeColor('#E5E7EB').stroke();

            // Customer Details
            doc.font(fontBold).fontSize(12).fillColor(primaryColor).text('CUSTOMER DETAILS', 40, 150);
            doc.font(fontRegular).fontSize(10).fillColor(textColor);
            
            const userName = ticket.user?.companyName || ticket.user?.name || 'Unknown Customer';
            const userEmail = ticket.user?.email || 'N/A';
            const userPhone = ticket.user?.phone || 'N/A';
            
            doc.text(`Name/Company: ${userName}`, 40, 170);
            doc.text(`Email: ${userEmail}`, 40, 185);
            doc.text(`Phone: ${userPhone}`, 40, 200);

            // Issue Details
            doc.font(fontBold).fontSize(12).fillColor(primaryColor).text('ISSUE DETAILS', 300, 150);
            doc.font(fontRegular).fontSize(10).fillColor(textColor);
            
            doc.text(`Issue Type: ${ticket.issueType}`, 300, 170);
            doc.text(`Priority: ${ticket.priority}`, 300, 185);
            if (ticket.shipmentId) {
                doc.text(`Shipment Ref: ${ticket.shipmentId}`, 300, 200);
            }

            // Description Box
            doc.moveDown(2);
            doc.font(fontBold).fontSize(12).fillColor(primaryColor).text('DESCRIPTION', 40, 240);
            
            doc.rect(40, 255, 515, 60).fillAndStroke('#F9FAFB', '#E5E7EB');
            doc.fillColor(textColor).font(fontRegular).fontSize(10);
            doc.text(ticket.description || 'No description provided.', 50, 265, { width: 495 });

            // Remarks / Chat History
            doc.moveDown(4);
            const chatY = 335;
            doc.font(fontBold).fontSize(12).fillColor(primaryColor).text('CHAT HISTORY / REMARKS', 40, chatY);
            
            let currentY = chatY + 25;
            
            if (ticket.remarks && ticket.remarks.length > 0) {
                ticket.remarks.forEach(remark => {
                    const textHeight = doc.font(fontRegular).fontSize(9).heightOfString(remark.text, { width: 475 });
                    const boxHeight = textHeight + 25;

                    // Page break logic
                    if (currentY + boxHeight > 750) {
                        doc.addPage();
                        currentY = 40;
                    }

                    const roleName = remark.role || 'Unknown';
                    const timeStr = new Date(remark.createdAt).toLocaleString('en-GB', { 
                        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' 
                    });
                    
                    // Draw message bubble background
                    const isCustomer = roleName === 'Customer';
                    const bubbleColor = isCustomer ? '#F3F4F6' : '#EFF6FF'; // Gray for customer, Blue for admin
                    const borderColor = isCustomer ? '#E5E7EB' : '#BFDBFE';
                    
                    doc.rect(40, currentY, 515, boxHeight).fillAndStroke(bubbleColor, borderColor);
                    
                    doc.font(fontBold).fontSize(9).fillColor('#4B5563').text(`${roleName} - ${timeStr}`, 50, currentY + 8);
                    doc.font(fontRegular).fillColor(textColor).text(remark.text, 50, currentY + 22, { width: 475 });
                    
                    currentY += boxHeight + 10;
                });
            } else {
                doc.font(fontRegular).fontSize(9).fillColor(textColor).text('No remarks or chat history available.', 40, currentY);
            }

            // Footer
            const pageCount = doc.bufferedPageRange().count;
            for (let i = 0; i < pageCount; i++) {
                doc.switchToPage(i);
                doc.font(fontRegular).fontSize(8).fillColor('#9CA3AF');
                // Place footer at 780 to avoid bottom margin triggers
                doc.text(`Page ${i + 1} of ${pageCount}`, 0, 780, { align: 'center', width: 595, lineBreak: false });
                doc.text('Generated by DFL Express Customer Support System', 40, 780, { align: 'left', lineBreak: false });
            }

            doc.end();

        } catch (error) {
            reject(error);
        }
    });
};

const generateTicketPDF = async (ticket) => {
    try {
        const pdfBuffer = await createTicketBuffer(ticket);
        const filename = `ticket_${ticket.ticketId}_${Date.now()}`;
        const uploadResult = await uploadToCloudinary(pdfBuffer, 'tickets', filename);
        return uploadResult.secure_url;
    } catch (error) {
        throw error;
    }
};

module.exports = { generateTicketPDF };
