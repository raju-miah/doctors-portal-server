const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config();
const jwt = require('jsonwebtoken');
const stripe = require("stripe")(process.env.STRIPE_SECRET);


const port = process.env.PORT || 5000;

const app = express();

// middleware
app.use(cors());
app.use(express.json());

// MongoDB



const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.ryrpoqq.mongodb.net/?retryWrites=true&w=majority`;

// console.log(uri);

const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverApi: ServerApiVersion.v1 });


// Verify JWT token 

function verifyJWT(req, res, next) {
    // console.log('token in jwt', req.headers.authorization);

    const authHeader = req.headers.authorization;

    if (!authHeader) {
        return res.status(401).send('unauthorized access')
    }

    const token = authHeader.split(' ')[1];

    jwt.verify(token, process.env.ACCESS_TOKEN, function (err, decoded) {
        if (err) {
            return res.status(403).send({ message: 'Forbidden access' })
        }

        req.decoded = decoded;

        next();
    })

}


async function run() {
    try {
        const appointmentOptionCollection = client.db('doctorsPortal').collection('appointmentOptions');

        const bookingsCollection = client.db('doctorsPortal').collection('bookings');
        const usersCollection = client.db('doctorsPortal').collection('users');
        const doctorsCollection = client.db('doctorsPortal').collection('doctors');
        const paymentsCollection = client.db('doctorsPortal').collection('payments');

        // Verify Admin

        const verifyAdmin = async (req, res, next) => {
            // console.log('inside verifyAdmin', req.decoded.email)

            const decodedEmail = req.decoded.email;
            const query = { email: decodedEmail };
            const user = await usersCollection.findOne(query);

            if (user?.role !== 'admin') {
                return res.status(403).send({ message: 'forbidden access' })
            }

            next();
        }



        // Appointment

        app.get('/appointmentOptions', async (req, res) => {
            const date = req.query.date;
            // console.log(date);
            const query = {};
            const cursor = appointmentOptionCollection.find(query);
            const appointmentOptions = await cursor.toArray();

            const bookingQuery = { appointmentDate: date };
            const alreadyBooked = await bookingsCollection.find(bookingQuery).toArray();

            appointmentOptions.forEach(option => {
                const optionBooked = alreadyBooked.filter(booked => booked.treatment === option.name);
                const bookedSlots = optionBooked.map(booked => booked.slot)
                const remainingSlots = option.slots.filter(slot => !bookedSlots.includes(slot))
                option.slots = remainingSlots;
                // console.log(date, option.name, remainingSlots.length);
            })

            res.send(appointmentOptions);
        });


        app.get('/appointmentSpecialty', async (req, res) => {
            const query = {};
            const result = await appointmentOptionCollection.find(query).project({
                name: 1
            }).toArray();
            res.send(result);
        })


        // Bookings


        app.get('/bookings', verifyJWT, async (req, res) => {
            const email = req.query.email;
            // console.log('token', req.headers.authorization);

            const decodedEmail = req.decoded.email;

            if (email !== decodedEmail) {
                return res.status(403).send({ message: 'forbidden access' })
            }

            const query = { email: email };
            const bookings = await bookingsCollection.find(query).toArray();
            res.send(bookings);
        });

        app.get('/bookings/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: ObjectId(id) };
            const result = await bookingsCollection.findOne(query);
            res.send(result);
        })

        app.post('/bookings', async (req, res) => {
            const booking = req.body;
            // console.log(booking);

            const query = {
                appointmentDate: booking.appointmentDate,
                email: booking.email,
                treatment: booking.treatment
            }
            const alreadyBooked = await bookingsCollection.find(query).toArray();

            if (alreadyBooked.length) {
                const message = `You already have a booking on ${booking.appointmentDate}`
                return res.send({ acknowledged: false, message });
            }


            const result = await bookingsCollection.insertOne(booking);
            res.send(result);
        });

        // payment

        app.post('/create-payment-intent', async (req, res) => {
            const booking = req.body;
            const price = booking.price;
            const amount = price * 100;

            const paymentIntent = await stripe.paymentIntents.create({
                currency: "usd",
                amount: amount,
                "payment_method_types": [
                    "card"
                ]
            });

            res.send({
                clientSecret: paymentIntent.client_secret,
            });
        });


        app.post('/payments', async (req, res) => {
            const payment = req.body;
            const result = await paymentsCollection.insertOne(payment);
            const id = payment.bookingId;
            const filter = { _id: ObjectId(id) };
            const updatedDoc = {
                $set: {
                    paid: true,
                    transactionId: payment.transactionId
                }
            }
            const updatedResult = await bookingsCollection.updateOne(filter, updatedDoc);
            res.send(result);
        })


        // users

        app.get('/jwt', async (req, res) => {
            const email = req.query.email;
            const query = { email: email };
            const user = await usersCollection.findOne(query);

            if (user) {
                const token = jwt.sign({ email }, process.env.ACCESS_TOKEN, { expiresIn: '1d' })
                return res.send({ accessToken: token })
            }

            // console.log(user);
            res.status(403).send({ accessToken: '' });
        });

        app.get('/users', async (req, res) => {
            const query = {};
            const users = await usersCollection.find(query).toArray();
            res.send(users);
        });

        app.get('/users/admin/:email', async (req, res) => {
            const email = req.params.email;
            const query = { email };
            const user = await usersCollection.findOne(query);
            res.send({ isAdmin: user?.role === 'admin' });
        })

        app.post('/users', async (req, res) => {
            const user = req.body;
            // console.log(user)
            const result = await usersCollection.insertOne(user);
            // console.log(result)
            res.send(result);
        });


        app.put('/users/admin/:id', verifyJWT, verifyAdmin, async (req, res) => {

            // const decodedEmail = req.decoded.email;
            // const query = { email: decodedEmail };
            // const user = await usersCollection.findOne(query);

            // if (user?.role !== 'admin') {
            //     return res.status(403).send({ message: 'forbidden access' })
            // }

            const id = req.params.id;
            const filter = { _id: ObjectId(id) };
            const options = { upsert: true };
            const updatedDoc = {
                $set: {
                    role: 'admin'
                }
            }

            const result = await usersCollection.updateOne(filter, updatedDoc, options);
            res.send(result);
        });


        // update price field 

        // app.get('/addPrice', async (req, res) => {
        //     const filter = {};
        //     const options = { upsert: true };
        //     const updatedDoc = {
        //         $set: {
        //             price: 99
        //         }
        //     }

        //     const result = await appointmentOptionCollection.updateMany(filter, updatedDoc, options)
        //     res.send(result);
        // })


        // doctors

        app.get('/doctors', verifyJWT, verifyAdmin, async (req, res) => {
            const query = {};
            const doctors = await doctorsCollection.find(query).toArray();
            res.send(doctors);
        });

        app.post('/doctors', verifyJWT, verifyAdmin, async (req, res) => {
            const doctor = req.body;
            const result = await doctorsCollection.insertOne(doctor);
            res.send(result);
        });

        app.delete('/doctors/:id', verifyJWT, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const query = { _id: ObjectId(id) };
            const result = await doctorsCollection.deleteOne(query);
            res.send(result);
        });


    }
    finally {

    }
}

run().catch(error => console.log(error));








app.get('/', (req, res) => {
    res.send('Doctor Portal Server Running')
})

app.listen(port, () => {
    console.log(`Doctor Portal Server Running on ${port}`);
})