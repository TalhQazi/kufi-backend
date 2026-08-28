const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { resolveRouteMatrix } = require('../utils/routeMatrix');

router.post('/resolve', auth(), async (req, res) => {
    try {
        const matrix = await resolveRouteMatrix(req.body?.points, {
            travelMode: req.body?.travelMode || 'driving',
        });
        res.json({
            ok: true,
            googleConfigured: matrix.googleConfigured,
            source: matrix.source,
            routes: [...matrix.byPair.values()],
        });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

module.exports = router;
