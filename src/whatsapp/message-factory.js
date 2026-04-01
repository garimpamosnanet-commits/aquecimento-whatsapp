const fs = require('fs');
const path = require('path');

// Banco de mensagens variadas para simular conversas reais
const MESSAGES = {
    greetings: [
        'Oi, tudo bem?', 'E aí, como vai?', 'Boa tarde!', 'Bom dia!',
        'Oi oi', 'Oii', 'Eai', 'Fala!', 'Opa, beleza?',
        'Olá!', 'Oi, sumido(a)!', 'Eae, quanto tempo!',
        'Bom diaaa', 'Boa noiteee', 'Boa tardee',
        'Oie tudo bem com vc?', 'Ei, como vc tá?',
        'Oi flor!', 'Oi amiga!', 'Eai mano', 'Salve!'
    ],
    responses: [
        'Tudo sim e vc?', 'To bem, graças a Deus', 'Tudo ótimo!',
        'Tudo tranquilo', 'De boa', 'Na paz', 'Tudo joia',
        'To bem sim!', 'Mais ou menos', 'Correria né',
        'Tudo certinho', 'Suave', 'Bem demais',
        'Tô bem! E por aí?', 'Tudo certo, e vc?',
        'Na correria mas tô bem', 'Aqui firme!',
        'De boas, e tu?', 'Tudo em cima', 'Bem e vc?'
    ],
    casual: [
        'Kkkkk', 'Verdade', 'Sim sim', 'Com certeza',
        'Pois é', 'Né?', 'Exato', 'Isso mesmo',
        'Aham', 'Uhum', 'Tá certo', 'Entendi',
        'Massa', 'Show', 'Top', 'Boa!',
        'Demais', 'Sério?', 'Nossa!', 'Caramba',
        'Que legal!', 'Adorei', 'Maravilha', 'Perfeito',
        'Kkkk boa', 'Hahahaha', 'Rsrs', 'Kkkkkkk'
    ],
    questions: [
        'O que vc tá fazendo?', 'Viu aquele negócio?',
        'Vc tá ocupado(a)?', 'Pode falar agora?',
        'Já almoçou?', 'Já jantou?', 'Vai sair hoje?',
        'Viu o jogo ontem?', 'Assistiu aquela série?',
        'O que vc acha?', 'Conhece alguém que faz isso?',
        'Tá calor aí tbm?', 'Choveu aí?', 'Vc trabalha amanhã?',
        'Qual o nome daquele lugar?', 'Lembra daquilo?',
        'Vc tem o contato?', 'Sabe onde vende?',
        'Onde vc comprou?', 'Quanto custou?'
    ],
    farewell: [
        'Bom, vou nessa', 'Tenho que ir', 'Depois a gente se fala',
        'Até mais!', 'Tchau!', 'Beijos!', 'Abraços!',
        'Fui!', 'Valeu!', 'Falou!', 'Até depois',
        'Bjs', 'Flw', 'Tmj', 'Até!',
        'Boa noite, vou dormir', 'To indo, depois falo',
        'Preciso desligar', 'Vou trabalhar', 'Até amanhã!'
    ],
    group_chat: [
        'Bom dia grupo!', 'Gente, vcs viram isso?',
        'Alguém sabe?', 'Concordo!', 'Penso igual',
        'Não sabia disso', 'Que interessante', 'Muito bom!',
        'Obrigado por compartilhar', 'Valeu pela info',
        'Boa noite pessoal', 'Oi gente!', 'Opa',
        'Alguém aí?', 'Olha isso kkk', 'Que top!',
        'Amei!', 'Maravilhoso!', 'Muito legal isso',
        'Caramba, não acredito', 'Sério isso?', 'Gente!!!'
    ],
    status_texts: [
        '☀️ Bom dia!', '🌙 Boa noite!', '💪 Foco!',
        '🙏 Gratidão', '❤️ Família', '📱 Online',
        '🏠 Em casa', '☕ Café', '🎵 Ouvindo música',
        '📚 Estudando', '💼 Trabalhando', '🏃 Se exercitando',
        '🍕 Hora do lanche', '😊 Feliz', '🌈 Dia lindo!',
        '✨ Energia positiva', '🔥 Motivado', '🌊 Na paz',
        '🎯 Focado', '💪 Determinação'
    ]
};

// Emojis para reações
const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '👏', '😍', '💯'];

class MessageFactory {
    static getRandomMessage(category) {
        const messages = MESSAGES[category];
        if (!messages) return 'Oi';
        return messages[Math.floor(Math.random() * messages.length)];
    }

    static getConversationFlow() {
        // Simula um mini-diálogo
        const flows = [
            ['greetings', 'responses', 'casual'],
            ['greetings', 'responses', 'questions', 'casual'],
            ['greetings', 'questions', 'responses'],
            ['greetings', 'responses', 'casual', 'farewell'],
            ['greetings', 'casual'],
            ['questions', 'responses'],
            ['casual', 'casual'],
            ['greetings', 'responses', 'questions', 'casual', 'farewell']
        ];
        return flows[Math.floor(Math.random() * flows.length)];
    }

    static getRandomReaction() {
        return REACTION_EMOJIS[Math.floor(Math.random() * REACTION_EMOJIS.length)];
    }

    static getStatusText() {
        return this.getRandomMessage('status_texts');
    }

    static getGroupMessage() {
        return this.getRandomMessage('group_chat');
    }

    static getGroupName() {
        const names = [
            'Família ❤️', 'Amigos 🤝', 'Galera 🔥', 'Grupo Top 💪',
            'Zueira 😂', 'Trabalho 💼', 'Faculdade 📚', 'Vizinhos 🏠',
            'Churras 🥩', 'Futebol ⚽', 'Receitas 🍳', 'Músicas 🎵',
            'Filmes 🎬', 'Viagem ✈️', 'Jogos 🎮', 'Notícias 📰',
            'Memes 🤣', 'Fitness 🏋️', 'Cozinheiros 👨‍🍳', 'Tech 💻'
        ];
        return names[Math.floor(Math.random() * names.length)];
    }

    // Get random media file from the media directory
    static getRandomMedia(type) {
        const mediaDir = path.join(__dirname, '..', '..', 'media', type);
        if (!fs.existsSync(mediaDir)) return null;

        const files = fs.readdirSync(mediaDir).filter(f => !f.startsWith('.'));
        if (files.length === 0) return null;

        const file = files[Math.floor(Math.random() * files.length)];
        return path.join(mediaDir, file);
    }

    // Generate random delay between actions (in ms)
    static getRandomDelay(minSeconds, maxSeconds) {
        const min = minSeconds * 1000;
        const max = maxSeconds * 1000;
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    // Check if current hour is within active hours
    static isActiveHour(startHour, endHour) {
        const now = new Date();
        const hour = now.getHours();
        return hour >= startHour && hour < endHour;
    }

    // Get typing delay based on message length (simulate human typing)
    static getTypingDelay(message) {
        // ~200ms per character, with some randomness
        const baseDelay = message.length * 150;
        const randomFactor = 0.5 + Math.random();
        return Math.min(Math.max(baseDelay * randomFactor, 1000), 8000);
    }
}

module.exports = MessageFactory;
