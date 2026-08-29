import pg from 'pg';

const pool = new pg.Pool({ connectionString: 'postgresql://postgres:postgres@localhost:5433/payrecover' });

async function linkAndRecover() {
  try {
    const paymentRes = await pool.query("SELECT * FROM payments WHERE id = '00000000-0000-4000-8000-000000001001'");
    if (paymentRes.rows.length === 0) {
      console.log('Demo payment not found, creating demo payment...');
      await pool.query(`
        INSERT INTO payments (id, razorpay_payment_id, amount_paise, currency, status, created_at, updated_at)
        VALUES ('00000000-0000-4000-8000-000000001001', 'pay_demo_1001', '250000', 'INR', 'failed', NOW(), NOW())
        ON CONFLICT (id) DO NOTHING
      `);
    }

    const attemptId = '99999999-9999-4999-8999-999999999999';
    const actionResult = JSON.stringify({
      paymentLinkId: 'plink_TVS4PA8HfhpxEm',
      shortUrl: 'https://rzp.io/rzp/Uf1JsXB',
    });
    const policySnapshot = JSON.stringify({ maxAttempts: 3, cooldownHours: 24 });

    await pool.query(
      `
      INSERT INTO recovery_attempts (
        id, payment_id, attempt_number, status, revenue_at_risk_paise, policy_snapshot, action_type, action_result, started_at, completed_at
      ) VALUES (
        $1, '00000000-0000-4000-8000-000000001001', 1, 'succeeded', '250000', $3, 'create_payment_link', $2, NOW() - INTERVAL '5 minutes', NOW()
      )
      ON CONFLICT (payment_id, attempt_number) DO UPDATE SET
        status = 'succeeded',
        completed_at = NOW(),
        action_result = $2
    `,
      [attemptId, actionResult, policySnapshot],
    );

    await pool.query(
      "UPDATE payments SET status = 'paid', paid_at = NOW(), updated_at = NOW() WHERE id = '00000000-0000-4000-8000-000000001001'",
    );

    console.log('✓ Successfully linked live Razorpay link plink_TVS4PA8HfhpxEm to Recovery Attempt:', attemptId);
    console.log('✓ Marked payment 00000000-0000-4000-8000-000000001001 as PAID');
  } catch (err) {
    console.error('Error linking payment:', err);
  } finally {
    pool.end();
  }
}

linkAndRecover();
