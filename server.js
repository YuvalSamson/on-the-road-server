package com.example.ontheroad  // תשאיר כמו אצלך אם שונה

import android.Manifest
import android.app.Activity
import android.location.Location
import android.location.LocationManager
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaPlayer
import android.os.Bundle
import android.util.Base64
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit

// כתובת השרת שלנו ב-Render
private const val BASE_URL = "https://on-the-road-server.onrender.com"

// OkHttp עם timeouts נדיבים
private val client = OkHttpClient.Builder()
    .connectTimeout(30, TimeUnit.SECONDS)
    .readTimeout(60, TimeUnit.SECONDS)
    .writeTimeout(30, TimeUnit.SECONDS)
    .build()

data class StoryBoth(
    val text: String,
    val audioBytes: ByteArray,
    val voiceKey: String?,   // למשל OPENAI_VOICE_NOVA
    val voiceId: String?,    // ה-id המלא של הקול
    val voiceIndex: Int?,    // אינדקס פנימי אם יש
    val lat: Double?,
    val lng: Double?
)

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            OnTheRoadScreen()
        }
    }
}

// פונקציה פשוטה שמחזירה מיקום אחרון אם יש (אחרי שיש הרשאה)
fun getLastKnownLocation(context: Context): Location? {
    val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    val providers = lm.getProviders(true)
    var best: Location? = null
    for (p in providers) {
        try {
            val l = lm.getLastKnownLocation(p) ?: continue
            if (best == null || l.accuracy < best!!.accuracy) {
                best = l
            }
        } catch (e: SecurityException) {
            // אין הרשאה - נתעלם, זה מטופל לפני הקריאה
        }
    }
    return best
}

// userId קבוע לרמת המכשיר - נשמר ב-SharedPreferences
fun getOrCreateUserId(context: Context): String {
    val prefs = context.getSharedPreferences("on_the_road_prefs", Context.MODE_PRIVATE)
    val existing = prefs.getString("user_id", null)
    if (!existing.isNullOrBlank()) return existing

    val newId = UUID.randomUUID().toString()
    prefs.edit().putString("user_id", newId).apply()
    return newId
}

@Composable
fun OnTheRoadScreen() {
    var story by remember { mutableStateOf("Press the button to get a story") }
    var loading by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val activity = context as? Activity

    var mediaPlayer by remember { mutableStateOf<MediaPlayer?>(null) }

    // בחירת שפה
    var selectedLanguageCode by remember { mutableStateOf("he") }
    var languageMenuExpanded by remember { mutableStateOf(false) }

    // בחירת מרווח בין סיפורים (לבינתיים רק UI, נשתמש בזה בשלב הבא לאוטומטי)
    var selectedIntervalMinutes by remember { mutableStateOf(0) }
    var intervalMenuExpanded by remember { mutableStateOf(false) }

    // ניקוי ה-Player כשהמסך נהרס
    DisposableEffect(Unit) {
        onDispose {
            mediaPlayer?.let { player ->
                try {
                    if (player.isPlaying) {
                        player.stop()
                    }
                    player.reset()
                    player.release()
                } catch (e: IllegalStateException) {
                    Log.w("OnTheRoad", "Error releasing MediaPlayer on dispose", e)
                }
            }
            mediaPlayer = null
        }
    }

    Surface(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(16.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(text = story)
            Spacer(modifier = Modifier.height(24.dp))

            // שורה של בחירת שפה + מרווח
            Row(
                horizontalArrangement = Arrangement.spacedBy(16.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                // בחירת שפה (עברית / אנגלית / צרפתית)
                Box {
                    Button(onClick = { languageMenuExpanded = true }) {
                        val label = when (selectedLanguageCode) {
                            "he" -> "עברית"
                            "en" -> "English"
                            "fr" -> "Français"
                            else -> "עברית"
                        }
                        Text("שפה: $label")
                    }
                    DropdownMenu(
                        expanded = languageMenuExpanded,
                        onDismissRequest = { languageMenuExpanded = false }
                    ) {
                        DropdownMenuItem(
                            text = { Text("עברית") },
                            onClick = {
                                selectedLanguageCode = "he"
                                languageMenuExpanded = false
                            }
                        )
                        DropdownMenuItem(
                            text = { Text("English") },
                            onClick = {
                                selectedLanguageCode = "en"
                                languageMenuExpanded = false
                            }
                        )
                        DropdownMenuItem(
                            text = { Text("Français") },
                            onClick = {
                                selectedLanguageCode = "fr"
                                languageMenuExpanded = false
                            }
                        )
                    }
                }

                // בחירת מרווח בין סיפורים
                Box {
                    Button(onClick = { intervalMenuExpanded = true }) {
                        val label = when (selectedIntervalMinutes) {
                            0 -> "ידני בלבד"
                            else -> "כל $selectedIntervalMinutes דק'"
                        }
                        Text("מרווח: $label")
                    }
                    DropdownMenu(
                        expanded = intervalMenuExpanded,
                        onDismissRequest = { intervalMenuExpanded = false }
                    ) {
                        DropdownMenuItem(
                            text = { Text("ידני בלבד") },
                            onClick = {
                                selectedIntervalMinutes = 0
                                intervalMenuExpanded = false
                            }
                        )
                        listOf(1, 2, 5, 10, 15, 30).forEach { minutes ->
                            DropdownMenuItem(
                                text = { Text("כל $minutes דק'") },
                                onClick = {
                                    selectedIntervalMinutes = minutes
                                    intervalMenuExpanded = false
                                }
                            )
                        }
                    }
                }
            }

            Spacer(modifier = Modifier.height(24.dp))

            Row(
                horizontalArrangement = Arrangement.spacedBy(16.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                // כפתור Get story
                Button(
                    onClick = {
                        scope.launch {
                            loading = true
                            try {
                                // 1. בדיקת הרשאת מיקום
                                val hasFine = ContextCompat.checkSelfPermission(
                                    context,
                                    Manifest.permission.ACCESS_FINE_LOCATION
                                ) == PackageManager.PERMISSION_GRANTED

                                val hasCoarse = ContextCompat.checkSelfPermission(
                                    context,
                                    Manifest.permission.ACCESS_COARSE_LOCATION
                                ) == PackageManager.PERMISSION_GRANTED

                                if (!hasFine && !hasCoarse) {
                                    if (activity != null) {
                                        ActivityCompat.requestPermissions(
                                            activity,
                                            arrayOf(Manifest.permission.ACCESS_FINE_LOCATION),
                                            1001
                                        )
                                    }
                                    story =
                                        "Location permission is required. Please approve and press again."
                                    return@launch
                                }

                                // 2. סוגרים נגן קודם אם קיים, בזהירות
                                mediaPlayer?.let { old ->
                                    try {
                                        if (old.isPlaying) {
                                            old.stop()
                                        }
                                        old.reset()
                                        old.release()
                                    } catch (e: IllegalStateException) {
                                        Log.w("OnTheRoad", "Error cleaning old MediaPlayer", e)
                                    }
                                }
                                mediaPlayer = null

                                // 3. משיגים מיקום אחרון
                                val location: Location? = getLastKnownLocation(context)
                                val lat = location?.latitude
                                val lng = location?.longitude

                                // 4. userId קבוע למכשיר
                                val userId = getOrCreateUserId(context)

                                // 5. שפה שנבחרה (he/en/fr)
                                val languageCode = selectedLanguageCode

                                // 6. בקשה אחת שמחזירה גם טקסט וגם אודיו – מאותו סיפור
                                val storyBoth = withContext(Dispatchers.IO) {
                                    fetchStoryBoth(client, lat, lng, userId, languageCode)
                                }

                                // כותרת עם ה-VOICE_ID שנבחר + מיקום אם יש
                                val header = buildString {
                                    append("Voice: ")
                                    if (!storyBoth.voiceKey.isNullOrBlank()) {
                                        append(storyBoth.voiceKey)
                                        storyBoth.voiceIndex?.let { idx ->
                                            append(" (#$idx)")
                                        }
                                    } else {
                                        append("unknown")
                                    }
                                    if (storyBoth.lat != null && storyBoth.lng != null) {
                                        append(
                                            "\nLocation: ${
                                                "%.4f".format(
                                                    storyBoth.lat
                                                )
                                            }, ${"%.4f".format(storyBoth.lng)}"
                                        )
                                    }
                                    append(
                                        "\nLanguage: ${
                                            when (languageCode) {
                                                "he" -> "עברית"
                                                "en" -> "English"
                                                "fr" -> "Français"
                                                else -> languageCode
                                            }
                                        }"
                                    )
                                }

                                story = header + "\n\n" + storyBoth.text

                                // כותבים את האודיו לקובץ זמני ומנגנים
                                val tempFile =
                                    File.createTempFile("story_", ".mp3", context.cacheDir)
                                tempFile.writeBytes(storyBoth.audioBytes)

                                val mp = MediaPlayer().apply {
                                    setDataSource(tempFile.absolutePath)
                                    setOnCompletionListener { player ->
                                        try {
                                            player.reset()
                                            player.release()
                                        } catch (e: IllegalStateException) {
                                            Log.w(
                                                "OnTheRoad",
                                                "Error releasing MediaPlayer on completion",
                                                e
                                            )
                                        } finally {
                                            mediaPlayer = null
                                        }
                                    }
                                    prepare()
                                    start()
                                }
                                mediaPlayer = mp
                            } catch (e: Exception) {
                                Log.e("OnTheRoad", "Error while getting story", e)
                                val name = e::class.simpleName ?: "Exception"
                                val msg = e.message ?: "no message"
                                story = "Error: $name - $msg"
                            } finally {
                                loading = false
                            }
                        }
                    },
                    enabled = !loading
                ) {
                    Text(if (loading) "Loading..." else "Get story")
                }

                // כפתור Stop – עוצר את ההשמעה הנוכחית
                Button(
                    onClick = {
                        try {
                            mediaPlayer?.let { player ->
                                try {
                                    if (player.isPlaying) {
                                        player.stop()
                                    }
                                    player.reset()
                                    player.release()
                                } catch (e: IllegalStateException) {
                                    Log.w("OnTheRoad", "Error stopping MediaPlayer", e)
                                } finally {
                                    mediaPlayer = null
                                }
                            }
                        } catch (e: Exception) {
                            Log.w("OnTheRoad", "Error in Stop button", e)
                        }
                    },
                    enabled = mediaPlayer != null && !loading
                ) {
                    Text("Stop")
                }
            }
        }
    }
}

// בקשה ל- /api/story-both – מחזירה גם טקסט, גם אודיו וגם מידע על הקול והlat/lng
suspend fun fetchStoryBoth(
    client: OkHttpClient,
    lat: Double?,
    lng: Double?,
    userId: String?,
    languageCode: String
): StoryBoth {
    val url = "$BASE_URL/api/story-both"

    val json = JSONObject().apply {
        put(
            "prompt",
            "Tell me a short, factual story with several real historical or geographic facts for a driver near this location."
        )
        if (lat != null && lng != null) {
            put("lat", lat)
            put("lng", lng)
        }
        put("language", languageCode)
    }

    val mediaType = "application/json; charset=utf-8".toMediaType()
    val body = json.toString().toRequestBody(mediaType)

    val requestBuilder = Request.Builder()
        .url(url)
        .post(body)

    if (!userId.isNullOrBlank()) {
        requestBuilder.addHeader("X-User-Id", userId)
    }

    val request = requestBuilder.build()

    client.newCall(request).execute().use { response ->
        if (!response.isSuccessful) {
            throw Exception("HTTP ${response.code} - ${response.message}")
        }
        val bodyStr = response.body?.string() ?: throw Exception("Empty body")

        val obj = JSONObject(bodyStr)
        val text = obj.getString("text")
        val audioBase64 = obj.getString("audioBase64")

        val voiceKey = obj.optString("voiceKey", null)
        val voiceId = obj.optString("voiceId", null)
        val voiceIndexRaw = obj.optInt("voiceIndex", -1)
        val voiceIndex = if (voiceIndexRaw > 0) voiceIndexRaw else null

        val audioBytes = Base64.decode(audioBase64, Base64.DEFAULT)

        return StoryBoth(
            text = text,
            audioBytes = audioBytes,
            voiceKey = voiceKey,
            voiceId = voiceId,
            voiceIndex = voiceIndex,
            lat = lat,
            lng = lng
        )
    }
}
