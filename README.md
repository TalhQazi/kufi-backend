# Kufi Travel Backend

Backend API for Kufi Travel application, built with Node.js, Express, and MongoDB.

## Setup

1.  **Install Dependencies**
    ```bash
    npm install
    ```

2.  **Environment Variables**
    Create a `.env` file in the root directory:
    ```env
    PORT=5000
    MONGO_URI=your_mongodb_connection_string
    JWT_SECRET=your_jwt_secret
    ```

3.  **Run Server**
    ```bash
    node server.js
    ```

## API List

### Health Check
- `GET /health`: Check server status and uptime.

### Authentication
- `POST /api/auth/register`: Register a new user (or supplier).
- `POST /api/auth/login`: Login and receive JWT.

### Activities (Public)
- `GET /api/activities`: List all travel activities.
- `GET /api/activities/:id`: Get details of a specific activity.

### Bookings (User)
- `POST /api/bookings`: Submit a new booking request.
- `GET /api/bookings/user/:userId`: Get bookings for a specific user.

### Supplier Panel (`/api/supplier`)
*Requires `x-auth-token` with Supplier role.*
- `GET /api/supplier/stats`: View supplier dashboard stats.
- `GET /api/supplier/activities`: List my activities.
- `POST /api/supplier/activities`: Create a new activity (Pending approval).
- `GET /api/supplier/bookings`: View bookings for my activities.

### Admin Panel (`/api/admin`)
*Requires `x-auth-token` with Admin role.*
- `GET /api/admin/stats`: System-wide analytics.
- `GET /api/admin/users`: Manage users.
- `DELETE /api/admin/users/:id`: Delete a user.
- `GET /api/admin/activities/pending`: View activities awaiting approval.
- `PUT /api/admin/activities/:id/approve`: Approve an activity.

## Models

- **User**: Authentication and role management.
- **Activity**: Travel packages/experiences.
- **Booking**: User reservations and details.
