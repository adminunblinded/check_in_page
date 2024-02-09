const http = require('http');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const app = express();
// Create an HTTP server and attach the WebSocket server to it
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.options('*', cors());
app.use(bodyParser.json());

let selectedRecords = [];

const salesforceCredentials = {
  client_id: '3MVG9p1Q1BCe9GmBa.vd3k6U6tisbR1DMPjMzaiBN7xn.uqsguNxOYdop1n5P_GB1yHs3gzBQwezqI6q37bh9', // Replace with your Salesforce Consumer Key
  client_secret: '1AAD66E5E5BF9A0F6FCAA681ED6720A797AC038BC6483379D55C192C1DC93190', // Replace with your Salesforce Consumer Secret
  username: 'admin@unblindedmastery.com', // Your Salesforce username
  password: process.env.PASSWORD // Concatenate your password and security token
};

// Function to ensure uniqueness based on opportunityId within the array
function uniqueByOpportunityIdWithinArray(arr) {
  const seenOpportunityIds = new Set();
  return arr.reduce((uniqueArray, recordsArray) => {
    const uniqueRecordsArray = recordsArray.selectedRecords.filter(record => { // Change this line
      const opportunityId = record.opportunityId;
      if (!seenOpportunityIds.has(opportunityId)) {
        seenOpportunityIds.add(opportunityId);
        return true;
      }
      return false;
    });

    if (uniqueRecordsArray.length > 0) {
      uniqueArray.push({ selectedRecords: uniqueRecordsArray });
    }
    return uniqueArray;
  }, []);
}

app.post('/select-records', (req, res) => {
  const receivedRecords = req.body;
  try {
    selectedRecords = selectedRecords.concat(receivedRecords);
    selectedRecords = uniqueByOpportunityIdWithinArray(selectedRecords);
    
    // Emit a WebSocket event to notify connected clients
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ event: 'selected-records-updated', data: selectedRecords }));
      }
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Error updating selected records:", error);
    res.status(500).json({ success: false, error: error.message || "Internal Server Error" });
  }
});

wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    const data = JSON.parse(message);
    if (data.event === 'fetch-selected-records') {
      // Send the updated records to the client
      ws.send(JSON.stringify({ event: 'selected-records', data: selectedRecords }));
    }
  });
});

// Route for getting Salesforce data
app.get('/salesforce-data', async (req, res) => {
  try {
    // Step 1: Get an access token
    const authResponse = await axios.post('https://login.salesforce.com/services/oauth2/token', null, {
      params: {
        grant_type: 'password',
        client_id: salesforceCredentials.client_id,
        client_secret: salesforceCredentials.client_secret,
        username: salesforceCredentials.username,
        password: salesforceCredentials.password,
      },
    });

    const accessToken = authResponse.data.access_token;
    const selectedEvent = req.query.eventId;
    
    // Step 2: Make a GET request to Salesforce API
    const query = `SELECT Name, Client_Mobile__c, Client_Email__c, Outstanding_Event_Balance__c, Program__c FROM Opportunity WHERE Live_Immersion__c = '${selectedEvent}'`;
    const sfApiUrl = `https://unblindedmastery.my.salesforce.com/services/data/v58.0/query/?q=${encodeURIComponent(query)}`;

    const sfApiResponse = await axios.get(sfApiUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    res.json(sfApiResponse.data);
  } catch (error) {
    res.json({ error: error.response ? error.response.data : error.message });
  }
});

// Route for updating Salesforce records
app.post('/update-salesforce-records', async (req, res) => {
  try {
    const selectedRecords = req.body; // Assuming the data is in JSON format

    // Step 1: Get an access token
    const authResponse = await axios.post('https://login.salesforce.com/services/oauth2/token', null, {
      params: {
        grant_type: 'password',
        client_id: salesforceCredentials.client_id,
        client_secret: salesforceCredentials.client_secret,
        username: salesforceCredentials.username,
        password: salesforceCredentials.password,
      },
    });
    const accessToken = authResponse.data.access_token;

    // Step 2: Update Salesforce records
    for (const record of selectedRecords) {
      const recordId = record.opportunityId; // Replace 'id' with the correct property name in your data
      const updateData = {
        StageName: 'Closed Won - Success',
        Create_Follow_Up_Opportunity__c: 'Engagement Call',
        In_Person_or_Virtual__c: record.VirtualInPerson
      };
      
      const dayField = `Attended_Day_${record.Days}__c`;
      updateData[dayField] = true; // Assuming the checkbox should be checked
      
      // Make a PATCH request to update the record
      const sfUpdateUrl = `https://unblindedmastery.my.salesforce.com/services/data/v58.0/sobjects/Opportunity/${recordId}`;
      await axios.patch(sfUpdateUrl, updateData, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });
    }

    res.json({ message: 'Records updated successfully' });
  } catch (error) {
    res.json({ error: error.response ? error.response.data : error.message });
  }
});

// Route for adding guests and opportunities
app.post('/addGuest', async (req, res) => {
  try {
    const { invitedBy, guests } = req.body;

    // Step 1: Get an access token
    const { access_token } = (await axios.post('https://login.salesforce.com/services/oauth2/token', null, {
      params: {
        grant_type: 'password',
        client_id: salesforceCredentials.client_id,
        client_secret: salesforceCredentials.client_secret,
        username: salesforceCredentials.username,
        password: salesforceCredentials.password,
      },
    })).data;

    // Step 2: Create Salesforce accounts and opportunities
    for (const guest of guests) {
      // Check if an account with the same email and phone number already exists
      let accountId;
      const existingAccount = await axios.get('https://unblindedmastery.my.salesforce.com/services/data/v58.0/query/', {
        params: {
          q: `SELECT Id FROM Account WHERE Email__c = '${guest.email}' OR Client_Mobile__c = '${guest.phone}' LIMIT 1`,
        },
        headers: { Authorization: `Bearer ${access_token}` },
      });

      if (existingAccount.data.totalSize > 0) {
        accountId = existingAccount.data.records[0].Id;
      } else {
        // Create a new account if it doesn't exist
        const { id } = (await axios.post('https://unblindedmastery.my.salesforce.com/services/data/v58.0/sobjects/Account', {
          Name: `${guest.firstName} ${guest.lastName}`,
          Client_Mobile__c: guest.phone,
          Email__c: guest.email,
        }, { headers: { Authorization: `Bearer ${access_token}` } })).data;
        accountId = id;
      }

      // Create an opportunity
      await axios.post('https://unblindedmastery.my.salesforce.com/services/data/v58.0/sobjects/Opportunity', {
        Name: `${guest.firstName} ${guest.lastName}`,
        Experience__c: 'Invite to Immersion',
        StageName: 'Closed Won - SUCCESS',
        CloseDate: '2024-01-25',
        Scheduled_By_External__c: invitedBy,
        Create_Follow_Up_Opportunity__c: 'Engagement Call',
        LeadSource: 'January Webinar 01.25.2024',
        RecordTypeId: '0125f000000zJDAAA2', // Replace with the actual Record Type Id
        AccountId: accountId,
        // Add other fields as needed
      }, { headers: { Authorization: `Bearer ${access_token}` } });
    }

    res.json({ message: 'Guests and opportunities created successfully' });
  } catch (error) {
    res.status(500).json({ error: error.response ? error.response.data : error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`);
});
