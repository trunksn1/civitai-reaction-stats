/**
 * Test script to check if Civitai API returns stats for a specific image
 * Usage: node scripts/test-image.js <imageId>
 *
 * You can find image IDs in the URL: https://civitai.com/images/12345678
 */

const imageId = process.argv[2];

if (!imageId) {
  console.log('Usage: node scripts/test-image.js <imageId>');
  console.log('Example: node scripts/test-image.js 12345678');
  console.log('\nYou can find the image ID in the URL when viewing an image on Civitai.');
  process.exit(1);
}

async function testImage(id) {
  console.log(`\nTesting image ID: ${id}`);
  console.log('='.repeat(50));

  // Try to find this image via the images endpoint
  const url = `https://civitai.com/api/v1/images?imageId=${id}`;
  console.log(`\nFetching: ${url}`);

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    if (data.items && data.items.length > 0) {
      const img = data.items[0];
      console.log('\nImage found!');
      console.log(`  ID: ${img.id}`);
      console.log(`  Created: ${img.createdAt}`);
      console.log(`  URL: https://civitai.com/images/${img.id}`);
      console.log('\nStats from API:');
      console.log(`  Likes: ${img.stats?.likeCount || 0}`);
      console.log(`  Hearts: ${img.stats?.heartCount || 0}`);
      console.log(`  Laughs: ${img.stats?.laughCount || 0}`);
      console.log(`  Cries: ${img.stats?.cryCount || 0}`);
      console.log(`  Comments: ${img.stats?.commentCount || 0}`);

      const total = (img.stats?.likeCount || 0) + (img.stats?.heartCount || 0) +
                    (img.stats?.laughCount || 0) + (img.stats?.cryCount || 0);
      console.log(`  TOTAL REACTIONS: ${total}`);

      if (total === 0) {
        console.log('\n⚠️  This image shows 0 reactions in the API.');
        console.log('   Check the website to see if it actually has reactions.');
      }
    } else {
      console.log('\n❌ Image not found in API response');
      console.log('   The image might be private, deleted, or the ID might be wrong.');
    }
  } catch (error) {
    console.error('\n❌ Error fetching image:', error.message);
  }

  // Also try the username filter to see if the image appears
  console.log('\n' + '='.repeat(50));
  console.log('Now checking via sort=Most Reactions to see images WITH stats:');

  try {
    const url2 = 'https://civitai.com/api/v1/images?limit=5&sort=Most%20Reactions';
    const response2 = await fetch(url2);
    const data2 = await response2.json();

    if (data2.items && data2.items.length > 0) {
      console.log('\nTop 5 images by reactions (any user):');
      for (const img of data2.items.slice(0, 5)) {
        const total = (img.stats?.likeCount || 0) + (img.stats?.heartCount || 0);
        console.log(`  ID ${img.id}: ${total} reactions (likes=${img.stats?.likeCount}, hearts=${img.stats?.heartCount})`);
      }
    }
  } catch (error) {
    console.error('Error:', error.message);
  }
}

testImage(imageId);

// Also test what the username endpoint returns
async function testUserImages(username) {
  if (!username) return;

  console.log('\n' + '='.repeat(50));
  console.log(`Testing images for user: ${username}`);

  try {
    // Test with sort=Most Reactions
    const url = `https://civitai.com/api/v1/images?username=${encodeURIComponent(username)}&limit=5&sort=Most%20Reactions`;
    console.log(`\nFetching with sort=Most Reactions...`);
    const response = await fetch(url);
    const data = await response.json();

    if (data.items && data.items.length > 0) {
      console.log('\nTop 5 images by reactions:');
      for (const img of data.items) {
        const total = (img.stats?.likeCount || 0) + (img.stats?.heartCount || 0);
        console.log(`  ID ${img.id}: ${total} reactions (created: ${img.createdAt})`);
      }
    }

    // Test with sort=Newest
    const url2 = `https://civitai.com/api/v1/images?username=${encodeURIComponent(username)}&limit=5&sort=Newest`;
    console.log(`\nFetching with sort=Newest...`);
    const response2 = await fetch(url2);
    const data2 = await response2.json();

    if (data2.items && data2.items.length > 0) {
      console.log('\n5 newest images:');
      for (const img of data2.items) {
        const total = (img.stats?.likeCount || 0) + (img.stats?.heartCount || 0);
        console.log(`  ID ${img.id}: ${total} reactions (created: ${img.createdAt})`);
      }
    }
  } catch (error) {
    console.error('Error:', error.message);
  }
}

// If CIVITAI_USERNAME is set, also test that
if (process.env.CIVITAI_USERNAME) {
  testUserImages(process.env.CIVITAI_USERNAME);
}
