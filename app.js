
// app.js
const express = require('express');
const { Pool } = require('pg');
const app = express();

app.use(express.json());

const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'rideconnect',
    password: '1',
    port: 5432,
});

// Helper function to calculate fare
function calculateFare(distanceKm, durationMinutes) {
    const BASE_FARE = 5.0;
    const PER_KM_RATE = 2.0;
    const PER_MINUTE_RATE = 0.5;
    
    return BASE_FARE + (distanceKm * PER_KM_RATE) + (durationMinutes * PER_MINUTE_RATE);
}

// Helper function to generate random route
function generateRandomRoute(pickup, dropoff) {
    return {
        points: [
            pickup,
            { lat: (pickup.lat + dropoff.lat) / 2, lng: (pickup.lng + dropoff.lng) / 2 },
            dropoff
        ],
        distance_km: Math.random() * 10 + 5, // Random distance between 5-15 km
    };
}

// 1. Request Ride Endpoint
app.post('/api/rides/request', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rider_id, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng } = req.body;

        // Create ride record without assigning a driver
        const rideResult = await client.query(
            `INSERT INTO rides (
                rider_id, 
                status, 
                pickup_lat, 
                pickup_lng, 
                dropoff_lat, 
                dropoff_lng
            )
            VALUES ($1, 'requested', $2, $3, $4, $5)
            RETURNING id`,
            [rider_id, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng]
        );

        // Get nearby available drivers (in a real application, you would use location-based queries)
        const availableDrivers = await client.query(
            `SELECT 
                d.user_id,
                d.current_location_lat,
                d.current_location_lng
            FROM drivers d
            WHERE d.is_available = true`
        );

        // In a real application, you would:
        // 1. Send notifications to nearby drivers
        // 2. Implement a timeout mechanism if no driver accepts
        // 3. Use WebSocket or similar for real-time updates

        await client.query('COMMIT');
        res.json({ 
            ride_id: rideResult.rows[0].id,
            available_drivers: availableDrivers.rows.length
        });
    } catch (error) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: error.message });
    } finally {
        client.release();
    }
});

// 2. Accept Ride Endpoint
app.post('/api/rides/:id/accept', async (req, res) => {
    const client = await pool.connect();
    try {
        const rideId = parseInt(req.params.id, 10);
        const driverId = parseInt(req.body.driver_id, 10);

        if (isNaN(rideId) || isNaN(driverId)) {
            return res.status(400).json({ error: 'Invalid ride_id or driver_id' });
        }

        await client.query('BEGIN');

        // Lock the ride record
        const rideCheck = await client.query(
            'SELECT id, status FROM rides WHERE id = $1 FOR UPDATE',
            [rideId]
        );

        if (rideCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Ride not found' });
        }

        if (rideCheck.rows[0].status !== 'requested') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Ride is not available' });
        }

        // Check if driver is available
        const driverCheck = await client.query(
            'SELECT user_id, is_available FROM drivers WHERE user_id = $1 FOR UPDATE',
            [driverId]
        );

        if (driverCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Driver not found' });
        }

        if (!driverCheck.rows[0].is_available) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Driver is not available' });
        }

        // Update ride status
        const updateRide = await client.query(
            `UPDATE rides 
             SET status = 'accepted', 
                 driver_id = $1, 
                 accept_time = NOW() 
             WHERE id = $2 AND status = 'requested' 
             RETURNING id, status, driver_id, accept_time`,
            [driverId, rideId]
        );

        // Update driver availability
        await client.query(
            'UPDATE drivers SET is_available = false WHERE user_id = $1',
            [driverId]
        );

        await client.query('COMMIT');

        return res.json({
            success: true,
            ride: updateRide.rows[0]
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error accepting ride:', error);
        return res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});


// 3. Get Ride Details Endpoint
app.get('/api/rides/:ride_id', async (req, res) => {
    try {
        const { ride_id } = req.params;
        
        const result = await pool.query(
            `SELECT 
                r.*,
                u1.name as rider_name,
                u2.name as driver_name,
                d.vehicle_make,
                d.vehicle_model,
                d.plate_number
            FROM rides r
            JOIN users u1 ON r.rider_id = u1.id
            LEFT JOIN users u2 ON r.driver_id = u2.id
            LEFT JOIN drivers d ON u2.id = d.user_id
            WHERE r.id = $1`,
            [ride_id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Ride not found' });
        }

        res.json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 4. Complete Ride Endpoint
app.post('/api/rides/:ride_id/complete', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { ride_id } = req.params;

        // Get ride details
        const rideResult = await client.query(
            'SELECT * FROM rides WHERE id = $1 FOR UPDATE',
            [ride_id]
        );

        if (rideResult.rows.length === 0) {
            throw new Error('Ride not found');
        }

        const ride = rideResult.rows[0];
        const route = generateRandomRoute({
            lat: ride.pickup_lat,
            lng: ride.pickup_lng
        }, {
            lat: ride.dropoff_lat,
            lng: ride.dropoff_lng
        });

        const duration = Math.floor(Math.random() * 30 + 15); // Random duration 15-45 minutes
        const fare = calculateFare(route.distance_km, duration);

        // Update ride record
        await client.query(
            `UPDATE rides 
             SET status = 'completed',
                 end_time = CURRENT_TIMESTAMP,
                 fare = $1,
                 distance_km = $2,
                 route_data = $3,
                 version = version + 1
             WHERE id = $4`,
            [fare, route.distance_km, JSON.stringify(route), ride_id]
        );

        // Create payment record
        await client.query(
            `INSERT INTO payments (ride_id, amount, status)
             VALUES ($1, $2, 'completed')`,
            [ride_id, fare]
        );

        await client.query('COMMIT');
        res.json({ 
            status: 'completed',
            fare,
            distance_km: route.distance_km,
            duration_minutes: duration
        });
    } catch (error) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: error.message });
    } finally {
        client.release();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});