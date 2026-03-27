// Seed script to populate initial booking terms
// Run this with: node seedBookingTerms.js

const mongoose = require('mongoose');
require('dotenv').config();

const BookingTerm = require('./models/BookingTerm');

const initialTerms = [
    {
        title: "Hotel",
        options: ["Include Hotel", "I will choose my own"],
        selectionType: "single",
        isActive: true,
        sortOrder: 1
    },
    {
        title: "Food Preference",
        options: ["All is good", "Vegetarian"],
        selectionType: "single",
        isActive: true,
        sortOrder: 2
    },
    {
        title: "Transportation",
        options: ["Included in Itinerary", "I need Transportation"],
        selectionType: "single",
        isActive: false,
        sortOrder: 3
    },
    {
        title: "Guide Preference",
        options: ["Male Guide", "Female Guide"],
        selectionType: "single",
        isActive: true,
        sortOrder: 4
    },
    {
        title: "Special Requirements",
        options: ["Wheelchair Accessible", "Dietary Restrictions", "Baby Seat Required", "Pet Friendly"],
        selectionType: "multiple",
        isActive: true,
        sortOrder: 5
    }
];

const seedBookingTerms = async () => {
    try {
        // Connect to database
        await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/kufi');
        console.log('Connected to MongoDB');

        // Clear existing terms (optional - remove if you want to keep existing)
        // await BookingTerm.deleteMany({});
        // console.log('Cleared existing terms');

        // Insert or update initial terms
        for (const term of initialTerms) {
            const existing = await BookingTerm.findOne({ title: term.title });
            if (!existing) {
                await BookingTerm.create(term);
                console.log(`Created term: ${term.title}`);
            } else {
                // Update existing term to match current config
                await BookingTerm.updateOne({ title: term.title }, { $set: term });
                console.log(`Updated term: ${term.title}`);
            }
        }

        console.log('\nSeed completed successfully!');
        process.exit(0);
    } catch (error) {
        console.error('Error seeding booking terms:', error);
        process.exit(1);
    }
};

seedBookingTerms();
