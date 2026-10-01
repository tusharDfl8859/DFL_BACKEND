const express = require('express');
const router = express.Router();
const { createTicket, getUserTickets, getTicketById } = require('../controllers/ticketController');
const { protect } = require('../middleware/authMiddleware');
const upload = require('../middleware/uploadMiddleware');

router.post('/', protect, upload.single('attachment'), createTicket);
router.get('/my-tickets', protect, getUserTickets);
router.get('/:id', protect, getTicketById);
router.post('/:id/chat', protect, upload.single('attachment'), require('../controllers/ticketController').addChatMessageUser);
router.delete('/:id/remarks/:remarkId', protect, require('../controllers/ticketController').deleteTicketRemark);

module.exports = router;
