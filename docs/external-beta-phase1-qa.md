# External Beta Phase 1 Functional QA Gate

No design changes are permitted during this gate. Rendering is not evidence that a write works.

## Dashboard
- Customer, invoice, quote, and product counts must be API-derived.
- Connector state and last-sync time must be backend-derived.
- A stale heartbeat must display offline.
- Recent activity must be real or explicitly unavailable.

## Customers
- List loads from the authorized company API.
- Search filters real customer records.
- Customer links resolve the correct company-scoped record.
- Loading, empty, and safe error states are present.

## Customer detail
- Name, status, contact information, balance, invoices, quotes, and activity must be API-derived or explicitly identified as unavailable.
- No mock customer data.

## Add Customer critical flow
1. Authenticated user opens Customers and Add Customer.
2. Client validates required fields and disables duplicate submission.
3. Frontend sends a Firebase bearer token, authorized company selection, normalized customer data, and idempotency key.
4. Worker validates user membership/company access and queues one customer.create job.
5. Assigned company connector claims once.
6. Official Sage 50 Canada SDK creates the customer.
7. Connector submits the terminal result.
8. Job becomes succeeded or failed.
9. Frontend refreshes and opens the created customer/list.
10. The same customer is manually confirmed in Sage 50.

A duplicate/retry must create exactly one Sage customer.

## Navigation
Verify Home, Customers, Invoices, Quotes, Products & Services, Reports, Settings, Help & Support, and Logout. Unsupported routes/actions must be hidden or explicitly unavailable.

## Authentication
- Unauthenticated app access rejected.
- Invalid/expired/unverified/wrong-project JWT rejected.
- Valid verified user maps to immutable Firebase UID in D1.
- User A cannot access Organization or Company B.
- Login survives refresh.
- Logout clears the browser session.
- Password-reset request works.
- No legacy browser API key or X-API-Key dependency.

## Responsive coverage
Test 390x844, 412x915, 820x1180, and 1440x1000 viewports; keyboard-open Add Customer; long customer names; large currency values. Fail clipping, overlap, horizontal overflow, or inaccessible submit controls.

## Required final matrix
- PASS/FAIL Dashboard data
- PASS/FAIL Customer list
- PASS/FAIL Customer search
- PASS/FAIL Customer detail
- PASS/FAIL Add Customer UI
- PASS/FAIL customer.create API
- PASS/FAIL connector processed job
- PASS/FAIL customer visible in Sage 50
- PASS/FAIL duplicate protection
- PASS/FAIL authentication
- PASS/FAIL navigation
- PASS/FAIL responsive layout

Every failure must name the exact cause and file/endpoint. Every write pass must include cloud job ID, Sage resource ID, connector result, and Sage 50 confirmation evidence.
