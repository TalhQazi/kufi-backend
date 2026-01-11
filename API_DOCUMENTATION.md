# Kufi Travel Backend API Documentation

Base URL: `http://localhost:5000`

## 1. Authentication

### Register User/Supplier
- **Endpoint**: `POST /api/auth/register`
- **Description**: Create a new account.
- **Body**:
  ```json
  {
    "name": "John Doe",
    "email": "john@example.com",
    "password": "secretpassword",
    "role": "user", // "user" or "supplier" (defaults to "user")
    "phone": "1234567890"
  }
  ```
- **Response**: `201 Created`
  ```json
  {
    "msg": "User registered successfully",
    "user": { ... }
  }
  ```

### Login
- **Endpoint**: `POST /api/auth/login`
- **Description**: Authenticate and receive a token.
- **Body**:
  ```json
  {
    "email": "john@example.com",
    "password": "secretpassword"
  }
  ```
- **Response**: `200 OK`
  ```json
  {
    "token": "eyJhbGciOiJIUz...",
    "user": { "id": "...", "role": "user" }
  }
  ```

---

## 2. Activities (Public)

### Get All Activities
- **Endpoint**: `GET /api/activities`
- **Description**: Retrieve a list of all approved travel activities.
- **Response**: `200 OK` (Array of Activity objects)

### Get Activity Details
- **Endpoint**: `GET /api/activities/:id`
- **Description**: Retrieve details for a specific activity.

---

## 3. Bookings (User)

### Create Booking
- **Endpoint**: `POST /api/bookings`
- **Description**: Submit a booking request.
- **Body**:
  ```json
  {
    "user": "USER_ID_OPTIONAL",
    "items": [
      {
        "activity": "ACTIVITY_ID",
        "title": "Desert Safari",
        "travelers": 2,
        "addOns": { "quadBiking": true }
      }
    ],
    "contactDetails": {
      "firstName": "John",
      "lastName": "Doe",
      "email": "john@example.com",
      "phone": "1234567890"
    },
    "tripDetails": {
      "country": "Dubai",
      "arrivalDate": "2024-12-01",
      "budget": "$2000"
    }
  }
  ```

### Get My Bookings
- **Endpoint**: `GET /api/bookings/user/:userId`
- **Description**: Get all bookings for a user.

---

## 4. Supplier Panel
**Headers Required**: `x-auth-token: <SUPPLIER_TOKEN>`

### Dashboard Stats
- **Endpoint**: `GET /api/supplier/stats`
- **Response**:
  ```json
  {
    "activities": 5,
    "bookings": 12,
    "revenue": 1200
  }
  ```

### Create Activity
- **Endpoint**: `POST /api/supplier/activities`
- **Body**:
  ```json
  {
    "title": "Mountain Trek",
    "description": "5 hours trekking...",
    "price": 150,
    "location": "Nepal",
    "image": "/assets/trek.jpg"
  }
  ```

### My Activities
- **Endpoint**: `GET /api/supplier/activities`

### Booking Requests
- **Endpoint**: `GET /api/supplier/bookings`

---

## 5. Admin Panel
**Headers Required**: `x-auth-token: <ADMIN_TOKEN>`

### System Stats
- **Endpoint**: `GET /api/admin/stats`

### Manage Users
- **Endpoint**: `GET /api/admin/users`
- **Endpoint**: `DELETE /api/admin/users/:id`

### Activity Moderation
- **Endpoint**: `GET /api/admin/activities/pending`
- **Endpoint**: `PUT /api/admin/activities/:id/approve`
