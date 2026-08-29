import { RazorpayClient } from '@payrecover/shared';

async function createRealLink() {
  const keyId = 'rzp_test_TUPNT34LWqZMZg';
  const keySecret = '0i3RNAGYK2lH4Zk6qMWPpvnI';

  const client = new RazorpayClient({ keyId, keySecret });

  console.log('Calling Razorpay Test Mode API (api.razorpay.com) to create a REAL payment link...');

  try {
    const link = await client.createPaymentLink({
      amount: 250000, // ₹2,500.00 in paise
      currency: 'INR',
      accept_partial: false,
      description: 'PayRecover AI Live Test Mode Recovery',
      customer: {
        name: 'Test Customer',
        email: 'testcustomer@example.com',
        contact: '+919876543210',
      },
      notify: {
        sms: false,
        email: false,
      },
      reminder_enable: false,
      notes: {
        system: 'payrecover-ai',
        environment: 'testmode',
      },
    });

    console.log('\n==================================================');
    console.log('REAL RAZORPAY TEST MODE PAYMENT LINK CREATED!');
    console.log('==================================================');
    console.log(`Payment Link ID: ${link.id}`);
    console.log(`Short URL:       ${link.short_url}`);
    console.log('==================================================\n');
  } catch (err) {
    console.error('Error creating link:', err.message);
  }
}

createRealLink();
