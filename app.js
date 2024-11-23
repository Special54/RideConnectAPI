// app.js
const express = require('express');
const { Pool } = require('pg');
const app = express();

app.use(express.json());

const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'RideApp',
    password: '1',
    port: 5432,
});

// Helper function to calculate fare
function calculateFare(distanceKm, durationMinutes, vehicleType) {
    const vehicleRates = {
        economy: { baseFare: 5.0, perKmRate: 2.0, perMinuteRate: 0.5 },
        premium: { baseFare: 10.0, perKmRate: 3.0, perMinuteRate: 1.0 },
        family: { baseFare: 7.0, perKmRate: 2.5, perMinuteRate: 0.75 }
    };

    const rates = vehicleRates[vehicleType] || vehicleRates.economy;
    return rates.baseFare + (distanceKm * rates.perKmRate) + (durationMinutes * rates.perMinuteRate);
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

// Add these helper functions at the top of the file
function getRandomLocation(baseLocation) {
    // NYC coordinates: 40.7128° N, -74.0060° W
    const NYC = {
        lat: 40.7128,
        lng: -74.0060
    };
    
    // Random offset within ~5km radius
    const lat = NYC.lat + (Math.random() - 0.5) * 0.1;  // +/- ~5km in lat
    const lng = NYC.lng + (Math.random() - 0.5) * 0.1;  // +/- ~5km in lng
    
    return { lat, lng };
}

// 1. Request Ride Endpoint
app.patch('/api/rides/:rider_id/request', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const rider_id = parseInt(req.params.rider_id, 10);
        
        // Generate random pickup and dropoff locations
        const pickup = getRandomLocation();
        const dropoff = getRandomLocation();

        // Insert pickup location
        const pickupLocationResult = await client.query(
            `INSERT INTO Locations (latitude, longitude, location_type)
            VALUES ($1, $2, 'pickup')
            RETURNING location_id`,
            [pickup.lat, pickup.lng]
        );
        const pickupLocationId = pickupLocationResult.rows[0].location_id;

        // Insert dropoff location
        const dropoffLocationResult = await client.query(
            `INSERT INTO Locations (latitude, longitude, location_type)
            VALUES ($1, $2, 'drop-off')
            RETURNING location_id`,
            [dropoff.lat, dropoff.lng]
        );
        const dropoffLocationId = dropoffLocationResult.rows[0].location_id;

        // Create ride record without assigning a driver
        const rideResult = await client.query(
            `INSERT INTO rides (
                status, 
                pickup_location_id,
                dropoff_location_id,
                fare_amount,
                ride_category
            )
            VALUES ('requested', $1, $2, $3, $4)
            RETURNING ride_id`,
            [pickupLocationId, dropoffLocationId, 0, 'Economy']
        );

        // Create ride record without assigning a driver
        const user_rideResult = await client.query(
            `INSERT INTO User_Ride (
            user_id,
            ride_id,
            role,
            start_time
            )
            VALUES ($1, $2, $3, NOW())`,
            [rider_id, rideResult.rows[0].ride_id, 'rider']
        );
        
        // Get nearby available drivers (in a real application, you would use location-based queries)
        const availableDrivers = await client.query(
            `SELECT 
                d.user_id
            FROM drivers d
            WHERE d.is_available = true`
        );
        
        await client.query('COMMIT');
        res.json({ 
            ride_id: rideResult.rows[0].ride_id,
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
app.patch('/api/rides/:id/accept', async (req, res) => {
    const client = await pool.connect();
    try {
        const rideId = parseInt(req.params.id, 10);
        const driverId = parseInt(req.body.driver_id, 10);

        if (isNaN(rideId) || isNaN(driverId)) {
            return res.status(400).json({ error: 'Invalid ride_id or driver_id' });
        }

        await client.query('BEGIN');
        
        // Set transaction isolation level to SERIALIZABLE
        await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');

        // Get exclusive lock on the ride row immediately with NOWAIT
        const rideCheck = await client.query(
            'SELECT ride_id, status FROM rides WHERE ride_id = $1 FOR UPDATE NOWAIT',
            [rideId]
        ).catch(err => {
            if (err.code === '55P03') { // lock_not_available
                throw new Error('Ride is currently being processed');
            }
            throw err;
        });

        if (rideCheck.rows.length === 0) {
            throw new Error('Ride not found');
        }

        if (rideCheck.rows[0].status !== 'requested') {
            throw new Error('Ride is not available');
        }

        // Get exclusive lock on the driver row with NOWAIT
        const driverCheck = await client.query(
            'SELECT user_id, is_available FROM drivers WHERE user_id = $1 FOR UPDATE NOWAIT',
            [driverId]
        ).catch(err => {
            if (err.code === '55P03') { // lock_not_available
                throw new Error('Driver is currently being processed');
            }
            throw err;
        });

        if (driverCheck.rows.length === 0) {
            throw new Error('Driver not found');
        }

        if (!driverCheck.rows[0].is_available) {
            throw new Error('Driver is not available');
        }

        // Update ride record after acquiring locks
        const updateRide = await client.query(
            `UPDATE rides 
             SET status = 'accepted'
             WHERE ride_id = $1 
             RETURNING ride_id, status`,
            [rideId]
        );
        // Update user_ride record after acquiring locks
        const updateUserRide = await client.query(
            `INSERT INTO user_ride (user_id, ride_id, role, start_time)
            VALUES ($1, $2, $3, NOW())`,
            [driverId, rideId, 'driver']
        );

        // Update driver availability
        await client.query(
            `UPDATE drivers 
             SET is_available = false
             WHERE user_id = $1`,
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
        
        if (error.message.includes('being processed')) {
            return res.status(409).json({ error: error.message });
        }
        if (error.message.includes('not found')) {
            return res.status(404).json({ error: error.message });
        }
        if (error.message.includes('not available')) {
            return res.status(400).json({ error: error.message });
        }
        
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
                r.id,
                r.status,
                r.pickup_lat,
                r.pickup_lng,
                r.dropoff_lat,
                r.dropoff_lng,
                r.fare,
                r.distance_km,
                r.accept_time,
                r.pickup_time,
                r.end_time,
                -- Rider details
                u1.id as rider_id,
                u1.name as rider_name,
                -- Driver details
                u2.id as driver_id,
                u2.name as driver_name,
                -- Vehicle details
                d.vehicle_make,
                d.vehicle_model,
                d.plate_number,
                d.vehicle_type
            FROM rides r
            INNER JOIN users u1 ON r.rider_id = u1.id
            LEFT JOIN users u2 ON r.driver_id = u2.id
            LEFT JOIN drivers d ON r.driver_id = d.user_id
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
app.patch('/api/rides/:ride_id/complete', async (req, res) => {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const { ride_id } = req.params;
        const { rider_id } = req.body;

        // Validate input
        if (!ride_id || isNaN(ride_id) || !rider_id || isNaN(rider_id)) {
            return res.status(400).json({ error: 'Invalid ride_id or rider_id' });
        }

        // Fetch ride details with an exclusive lock
        const rideResult = await client.query(
            'SELECT * FROM rides WHERE ride_id = $1 FOR UPDATE',
            [ride_id]
        );

        if (rideResult.rows.length === 0) {
            throw new Error('Ride not found');
        }

        const ride = rideResult.rows[0];



        // Mark the ride as completed
        await client.query(
            `UPDATE rides
             SET status = 'completed'
             WHERE ride_id = $1`,
            [ride_id]
        );

        // Insert payment details
        await client.query(
            `INSERT INTO payments (ride_id, rider_id, payment_status)
             VALUES ($1, $2, $3)`,
            [ride_id, rider_id, "success"]
        );
        // Update driver availability
        await client.query(
            `UPDATE drivers 
             SET is_available = true
             WHERE user_id = $1`,
            [ride.driver_id]
        );
        // Commit the transaction
        await client.query('COMMIT');

        // Respond with success
        res.json({
            status: 'success',
            message: 'Ride completed',
            payment_status: "success"
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error completing ride:', error);

        if (error.message === 'Ride not found') {
            return res.status(404).json({ error: error.message });
        }

        if (error.message === 'Ride is not in progress') {
            return res.status(400).json({ error: error.message });
        }

        return res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});