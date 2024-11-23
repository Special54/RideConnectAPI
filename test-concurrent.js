const axios = require('axios');
const { Pool } = require('pg');

const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'rideconnect',
    password: '1',
    port: 5432,
});

class ConcurrencyTester {
    constructor() {
        this.baseUrl = 'http://localhost:3000/api';
    }

    async cleanupDatabase() {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`
                UPDATE rides SET 
                    status = 'completed',
                    accept_time = NULL,
                    driver_id = NULL
                WHERE status IN ('requested', 'accepted')`);
            await client.query(`
                UPDATE drivers SET 
                    is_available = true`);
            await client.query('COMMIT');
            console.log('Database cleaned up successfully');
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Cleanup failed:', error);
        } finally {
            client.release();
        }
    }

    async createTestRide() {
        try {
            console.log('Attempting to create test ride with payload:', {
                rider_id: 1,
                pickup_lat: 40.7128,
                pickup_lng: -74.0060,
                dropoff_lat: 40.7580,
                dropoff_lng: -73.9855
            });

            const response = await axios.patch(`${this.baseUrl}/rides/1/request`, {
                pickup_lat: 40.7128,
                pickup_lng: -74.0060,
                dropoff_lat: 40.7580,
                dropoff_lng: -73.9855
            });
            
            console.log('Received response:', response.data);

            if (!response.data || !response.data.ride_id) {
                console.error('Invalid response structure:', response.data);
                throw new Error('Invalid response structure from ride creation');
            }
            
            console.log('Test ride created successfully with ID:', response.data.ride_id);
            return response.data.ride_id;
        } catch (error) {
            if (error.response) {
                console.error('Server responded with error:', {
                    status: error.response.status,
                    data: error.response.data,
                    headers: error.response.headers
                });
            } else if (error.request) {
                console.error('No response received from server:', error.request);
            } else {
                console.error('Error setting up request:', error.message);
            }
            throw error;
        }
    }

    async simulateConcurrentAcceptance(rideId, numberOfDrivers = 3) {
        if (!rideId) {
            throw new Error('Invalid ride ID');
        }
    
        console.log(`\nTesting ${numberOfDrivers} drivers trying to accept ride ${rideId} simultaneously...`);
        
        const acceptancePromises = Array.from({ length: numberOfDrivers }, (_, index) => {
            const driverId = index + 1;
            return () => axios.patch(`${this.baseUrl}/rides/${rideId}/accept`, {
                driver_id: driverId
            }, {
                headers: {
                    'Content-Type': 'application/json'
                }
            })
            .then(response => ({
                status: 'fulfilled',
                driverId,
                data: response.data
            }))
            .catch(error => ({
                status: 'rejected',
                driverId,
                error: error.response?.data || error.message
            }));
        });
    
        // Execute all promises as simultaneously as possible
        const results = await Promise.all(acceptancePromises.map(fn => fn()));
    
        let successfulDriver = null;
        let acceptedCount = 0;
        console.log('\nResults:');
        results.forEach(result => {
            if (result.status === 'fulfilled') {
                successfulDriver = result.driverId;
                acceptedCount++;
                console.log(`✅ Driver ${result.driverId} successfully accepted the ride`);
                console.log('Ride details:', JSON.stringify(result.data, null, 2));
            } else {
                console.log(`❌ Driver ${result.driverId} failed:`, result.error);
            }
        });
    
        if (acceptedCount > 1) {
            console.error(`⚠️ Warning: ${acceptedCount} drivers were able to accept the ride! Expected only one.`);
        }
    
        await this.verifyFinalState(rideId, successfulDriver);
    }

    async verifyFinalState(rideId, successfulDriver) {
        const client = await pool.connect();
        try {
            console.log('\nVerifying final state:');

            const rideResult = await client.query(
                'SELECT status, driver_id, accept_time FROM rides WHERE id = $1',
                [rideId]
            );
            const ride = rideResult.rows[0];
            
            console.log('\nRide Status:', {
                status: ride.status,
                driver_id: ride.driver_id,
                accept_time: ride.accept_time
            });

            if (successfulDriver) {
                const driverResult = await client.query(
                    'SELECT user_id, is_available FROM drivers WHERE user_id = $1',
                    [successfulDriver]
                );
                const winningDriver = driverResult.rows[0];

                console.log('\nWinning Driver Status:', {
                    driver_id: winningDriver.user_id,
                    is_available: winningDriver.is_available
                });

                const isConsistent = ride.status === 'accepted' && 
                                   ride.driver_id === successfulDriver && 
                                   !winningDriver.is_available &&
                                   ride.accept_time !== null;

                console.log('\nData Consistency:', isConsistent ? '✅ Consistent' : '❌ Inconsistent');
            } else {
                console.log('\nNo driver successfully accepted the ride');
            }

        } catch (error) {
            console.error('Verification failed:', error);
        } finally {
            client.release();
        }
    }

    async runCompleteTest(numberOfDrivers = 3) {
        try {
            console.log('Starting concurrent acceptance test...');
            
            await this.cleanupDatabase();

            const rideId = await this.createTestRide();
            if (!rideId) {
                throw new Error('Failed to get valid ride ID');
            }
            console.log(`Created test ride with ID: ${rideId}`);

            // Add a small delay to ensure the ride is properly created
            await new Promise(resolve => setTimeout(resolve, 1000));

            await this.simulateConcurrentAcceptance(rideId, numberOfDrivers);

        } catch (error) {
            console.error('Test failed:', error);
        } finally {
            await pool.end();
        }
    }
}

// Run the test
const tester = new ConcurrencyTester();
tester.runCompleteTest(3)
    .then(() => process.exit(0))
    .catch(error => {
        console.error('Test failed:', error);
        process.exit(1);
    });