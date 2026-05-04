const Booking = require('../models/Booking');
const Activity = require('../models/Activity');
const User = require('../models/User');
const AnalyticsSession = require('../models/AnalyticsSession');
const AnalyticsDaily = require('../models/AnalyticsDaily');

const getDayKey = (date = new Date()) => {
    const d = new Date(date);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
};

const getLastNDays = (n) => {
    const out = [];
    const now = new Date();
    for (let i = n - 1; i >= 0; i--) {
        const d = new Date(now);
        d.setUTCDate(now.getUTCDate() - i);
        out.push(d);
    }
    return out;
};

const parseBudgetNumber = (value) => {
    if (!value) return 0;
    const raw = String(value);
    const digits = raw.replace(/[^0-9.]/g, '');
    const num = Number(digits);
    return Number.isFinite(num) ? num : 0;
};

const safePercent = (part, total) => {
    if (!total) return 0;
    return Math.round((part / total) * 1000) / 10;
};

// Get supplier analytics
exports.getSupplierAnalytics = async (req, res) => {
    try {
        const supplierId = req.user.id;

        // 1. Get supplier's activities
        const myActivities = await Activity.find({ supplier: supplierId }).select('_id');
        const activityIds = myActivities.map(a => a._id);

        // 2. Get bookings containing these activities (limit to 500 for safety)
        const bookings = await Booking.find({ 'items.activity': { $in: activityIds } }).limit(500);

        // 3. Calculate statistics
        const pendingRequests = bookings.filter(b => b.status === 'pending').length;
        const acceptedRequests = bookings.filter(b => b.status === 'confirmed').length;
        const rejectedRequests = bookings.filter(b => b.status === 'cancelled').length;

        const totalRevenue = bookings
            .filter(b => b.status === 'confirmed')
            .reduce((sum, b) => {
                // Simplified revenue calculation: sum of item prices if available, or trip budget
                // For now, let's use a placeholder if prices aren't fully structured
                return sum + (parseInt(b.tripDetails?.budget?.replace(/[^0-9]/g, '')) || 0);
            }, 0);

        const overview = [
            { label: "Total Revenue", value: `$${totalRevenue.toLocaleString()}`, delta: "Real-time", icon: "DollarSign" },
            { label: "Active Bookings", value: String(bookings.filter(b => b.status === 'confirmed').length), delta: "Total", icon: "CalendarDays" },
            { label: "Average Rating", value: "4.8", delta: "+0.3", icon: "Star" }, // Keep rating mockup for now
            { label: "Experiences", value: String(myActivities.length), delta: "Active", icon: "Briefcase" },
        ];

        const travelerStats = [
            { label: "Total Pending Requests", value: pendingRequests, icon: "Clock3" },
            { label: "Accepted Requests", value: acceptedRequests, icon: "Check" },
            { label: "Rejected Requests", value: rejectedRequests, icon: "XIcon" },
        ];

        res.json({ overview, travelerStats });
    } catch (err) {
        console.error('Error fetching supplier analytics:', err.message);
        res.status(500).send('Server error');
    }
};

// Track a page view (traffic)
exports.trackPageView = async (req, res) => {
    try {
        const { sessionId, path, role, userId } = req.body || {};
        if (!sessionId) {
            return res.status(400).json({ msg: 'sessionId is required' });
        }

        const now = new Date();
        const day = getDayKey(now);

        const existing = await AnalyticsSession.findOne({ sessionId }).select('_id');
        const isNewVisitor = !existing;

        const setFields = {
            lastSeenAt: now,
            lastPath: String(path || '')
        };
        if (userId) setFields.userId = userId;
        if (role) setFields.role = role;

        await AnalyticsSession.updateOne(
            { sessionId },
            {
                $setOnInsert: {
                    sessionId,
                    startedAt: now
                },
                $set: setFields,
                $inc: {
                    pageViews: 1
                }
            },
            { upsert: true }
        );

        await AnalyticsDaily.updateOne(
            { day },
            {
                $setOnInsert: { day },
                $inc: {
                    pageViews: 1,
                    ...(isNewVisitor ? { visitors: 1 } : {})
                }
            },
            { upsert: true }
        );

        res.json({ ok: true });
    } catch (err) {
        console.error('Error tracking pageview:', err.message);
        res.status(500).send('Server error');
    }
};

// Track a session heartbeat (active users + time on site)
exports.trackHeartbeat = async (req, res) => {
    try {
        const { sessionId, seconds, role, userId, path } = req.body || {};
        if (!sessionId) {
            return res.status(400).json({ msg: 'sessionId is required' });
        }

        const now = new Date();
        const delta = Number(seconds);
        const deltaSafe = Number.isFinite(delta) && delta > 0 && delta < 3600 ? delta : 0;

        const setFields = {
            lastSeenAt: now
        };
        if (path) setFields.lastPath = String(path);
        if (userId) setFields.userId = userId;
        if (role) setFields.role = role;

        const update = {
            $setOnInsert: {
                sessionId,
                startedAt: now
            },
            $set: setFields
        };
        if (deltaSafe) {
            update.$inc = { totalSeconds: deltaSafe };
        }

        await AnalyticsSession.updateOne(
            { sessionId },
            update,
            { upsert: true }
        );

        res.json({ ok: true });
    } catch (err) {
        console.error('Error tracking heartbeat:', err.message);
        res.status(500).send('Server error');
    }
};

// Get admin analytics
exports.getAdminAnalytics = async (req, res) => {
    try {
        const now = new Date();
        const activeCutoff = new Date(now.getTime() - 5 * 60 * 1000); // last 5 minutes

        const [
            totalTraffic,
            activeUsers,
            totalUsers,
            totalBookings
        ] = await Promise.all([
            AnalyticsSession.countDocuments(),
            AnalyticsSession.countDocuments({ lastSeenAt: { $gte: activeCutoff } }),
            User.countDocuments({ role: 'user' }),
            Booking.countDocuments()
        ]);

        const confirmedBookings = await Booking.find({ status: 'confirmed' })
            .select('tripDetails createdAt items')
            .sort({ createdAt: -1 })
            .limit(1000);
        const revenueNumber = (confirmedBookings || []).reduce((sum, b) => sum + parseBudgetNumber(b.tripDetails?.budget), 0);
        const conversionRate = safePercent(totalBookings, totalTraffic);

        const statCards = [
            { label: 'Total Traffic', value: String(totalTraffic), change: 'Real-time', icon: 'Users', color: 'bg-blue-500' },
            { label: 'Active Users', value: String(activeUsers), change: 'Last 5 min', icon: 'Users', color: 'bg-green-500' },
            { label: 'Revenue', value: `$${Math.round(revenueNumber).toLocaleString()}`, change: 'Confirmed', icon: 'DollarSign', color: 'bg-purple-500' },
            { label: 'Conversion Rate', value: `${conversionRate}%`, change: 'Bookings/Visitors', icon: 'Percent', color: 'bg-orange-500' },
        ];

        const days = getLastNDays(7);
        const dayKeys = days.map((d) => getDayKey(d));
        const dailyRows = await AnalyticsDaily.find({ day: { $in: dayKeys } }).select('day visitors pageViews');
        const dailyMap = new Map((dailyRows || []).map((r) => [r.day, r]));

        const trafficLabels = days.map((d) => d.toLocaleDateString('en-US', { weekday: 'short' }));
        const visitorsSeries = dayKeys.map((k) => Number(dailyMap.get(k)?.visitors || 0));
        const pageViewsSeries = dayKeys.map((k) => Number(dailyMap.get(k)?.pageViews || 0));

        const trafficData = {
            labels: trafficLabels,
            datasets: [
                {
                    label: 'Visitors',
                    data: visitorsSeries,
                    borderColor: '#22c55e',
                    backgroundColor: 'rgba(34,197,94,0.1)',
                    tension: 0.4
                },
                {
                    label: 'Page Views',
                    data: pageViewsSeries,
                    borderColor: '#3b82f6',
                    backgroundColor: 'rgba(59,130,246,0.1)',
                    tension: 0.4
                }
            ]
        };

        const bookingsByCategoryAgg = await Activity.aggregate([
            {
                $lookup: {
                    from: 'bookings',
                    localField: '_id',
                    foreignField: 'items.activity',
                    as: 'bookingRefs'
                }
            },
            {
                $project: {
                    category: { $ifNull: ['$category', 'Other'] },
                    bookingCount: { $size: '$bookingRefs' }
                }
            },
            {
                $group: {
                    _id: '$category',
                    count: { $sum: '$bookingCount' }
                }
            },
            { $sort: { count: -1 } },
            { $limit: 6 }
        ]);

        const categoryLabels = (bookingsByCategoryAgg || []).map((r) => r._id || 'Other');
        const categoryCounts = (bookingsByCategoryAgg || []).map((r) => Number(r.count || 0));
        const colors = ['#2563eb', '#22c55e', '#f97316', '#facc15', '#a855f7', '#ef4444'];
        const bookingsData = {
            labels: categoryLabels.length ? categoryLabels : ['Other'],
            datasets: [
                {
                    data: categoryCounts.length ? categoryCounts : [0],
                    backgroundColor: colors.slice(0, Math.max(1, categoryLabels.length))
                }
            ]
        };

        const sessionCount = await AnalyticsSession.countDocuments();
        const totals = await AnalyticsSession.aggregate([
            {
                $group: {
                    _id: null,
                    totalSeconds: { $sum: '$totalSeconds' },
                    totalPageViews: { $sum: '$pageViews' }
                }
            }
        ]);
        const totalSeconds = Number(totals?.[0]?.totalSeconds || 0);
        const totalPageViews = Number(totals?.[0]?.totalPageViews || 0);
        const avgSeconds = sessionCount ? Math.round(totalSeconds / sessionCount) : 0;
        const pagesPerSession = sessionCount ? Math.round((totalPageViews / sessionCount) * 10) / 10 : 0;

        const mins = Math.floor(avgSeconds / 60);
        const secs = avgSeconds % 60;
        const avgSessionDuration = `${mins}m ${secs}s`;

        const engagementMetrics = [
            { label: 'Avg. Session Duration', value: avgSessionDuration, change: 'Real-time', color: 'bg-blue-500', changeColor: 'text-gray-500' },
            { label: 'Pages per Session', value: String(pagesPerSession), change: 'Real-time', color: 'bg-green-500', changeColor: 'text-gray-500' },
            { label: 'Bounce Rate', value: '—', change: 'Not tracked', color: 'bg-purple-500', changeColor: 'text-gray-500' },
        ];

        // Top performing listings: bookings + revenue from confirmed bookings (budget-based)
        // Reuse confirmedBookings from earlier to avoid duplicate query
        const confirmedBookingDocs = confirmedBookings;
        const perActivity = new Map();
        (confirmedBookingDocs || []).forEach((b) => {
            const budget = parseBudgetNumber(b.tripDetails?.budget);
            const items = Array.isArray(b.items) ? b.items : [];
            const uniqueActivityIds = [...new Set(items.map((it) => String(it?.activity || '')).filter(Boolean))];
            const share = uniqueActivityIds.length ? budget / uniqueActivityIds.length : 0;
            uniqueActivityIds.forEach((id) => {
                const curr = perActivity.get(id) || { bookings: 0, revenue: 0 };
                curr.bookings += 1;
                curr.revenue += share;
                perActivity.set(id, curr);
            });
        });

        const topIds = [...perActivity.entries()]
            .sort((a, b) => {
                if (b[1].revenue !== a[1].revenue) return b[1].revenue - a[1].revenue;
                return b[1].bookings - a[1].bookings;
            })
            .slice(0, 6)
            .map(([id]) => id);

        const activities = topIds.length
            ? await Activity.find({ _id: { $in: topIds } }).select('title')
            : [];
        const activityTitleMap = new Map((activities || []).map((a) => [String(a._id), a.title]));

        const totalVisitors7d = visitorsSeries.reduce((sum, v) => sum + Number(v || 0), 0);

        const topListings = topIds.map((id) => {
            const stats = perActivity.get(id) || { bookings: 0, revenue: 0 };
            const views = 0;
            const conversion = views ? `${safePercent(stats.bookings, views)}%` : '—';
            return {
                listing: activityTitleMap.get(String(id)) || 'Activity',
                views: String(views),
                bookings: String(stats.bookings),
                revenue: `$${Math.round(stats.revenue).toLocaleString()}`,
                conversion
            };
        });

        // Simple traffic deltas based on last 2 days visitors
        const todayVisitors = visitorsSeries[visitorsSeries.length - 1] || 0;
        const yesterdayVisitors = visitorsSeries[visitorsSeries.length - 2] || 0;
        const trafficDelta = yesterdayVisitors ? `${Math.round(((todayVisitors - yesterdayVisitors) / yesterdayVisitors) * 100)}%` : 'Real-time';
        statCards[0].change = trafficDelta;

        // Active users delta based on total users (informational)
        statCards[1].change = totalUsers ? `${safePercent(activeUsers, totalUsers)}% of users` : 'Real-time';

        // Revenue delta: based on avg revenue per confirmed booking
        const avgRevenue = confirmedBookings.length ? Math.round(revenueNumber / confirmedBookings.length) : 0;
        statCards[2].change = avgRevenue ? `Avg $${avgRevenue}` : 'Confirmed';

        // Conversion delta based on last 7 days visitors
        statCards[3].change = totalVisitors7d ? `7d: ${totalVisitors7d}` : 'Bookings/Visitors';

        res.json({ statCards, trafficData, bookingsData, engagementMetrics, topListings });
    } catch (err) {
        console.error('Error fetching admin analytics:', err.message);
        res.status(500).send('Server error');
    }
};
